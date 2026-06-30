// HTTP server: serves the UI, starts research runs, and streams live progress
// over SSE. Runs are fire-and-forget; their event log is replayed to any client
// that connects (or reconnects) mid-run, and persisted to disk on completion.

import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { requireAuth } from "./auth.js";
import { authMode, config } from "./config.js";
import { runPipeline, type PipelineEvent, type RunRecord } from "./pipeline.js";
import { listSummaries, loadRecord, saveRecord } from "./store.js";
import { newId } from "./util.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "..", "public");

interface LiveRun {
  record: RunRecord;
  subscribers: Set<(ev: PipelineEvent) => void>;
  done: boolean;
}

const runs = new Map<string, LiveRun>();

function freshRecord(goal: string): RunRecord {
  return {
    id: newId(),
    goal,
    status: "running",
    createdAt: new Date().toISOString(),
    authMode: authMode(),
    subtopics: [],
    factChecks: [],
    usage: {},
    costUsd: 0,
    events: [],
  };
}

function startRun(goal: string): RunRecord {
  const record = freshRecord(goal);
  const run: LiveRun = { record, subscribers: new Set(), done: false };
  runs.set(record.id, run);

  const emit = (ev: PipelineEvent): void => {
    record.events.push(ev);
    for (const sub of run.subscribers) {
      try {
        sub(ev);
      } catch {
        /* a dead client must not break the run */
      }
    }
    if (ev.type === "done") run.done = true;
  };

  void (async () => {
    await runPipeline(record, emit); // never throws — it emits an error event
    await saveRecord(record).catch((e) => app.log.error(e, "failed to persist run"));
  })();

  return record;
}

const app = Fastify({ logger: true });

await app.register(fastifyStatic, { root: publicDir, prefix: "/" });

// Public health check (used by the Docker HEALTHCHECK).
app.get("/api/health", async () => ({ ok: true }));

// Everything below requires the shared secret.
app.get("/api/config", { preHandler: requireAuth }, async () => ({
  authMode: authMode(),
  models: config.models,
  fanoutWidth: config.fanoutWidth,
  maxRounds: config.maxRounds,
  workerConcurrency: config.workerConcurrency,
}));

app.get("/api/runs", { preHandler: requireAuth }, async () => ({ runs: await listSummaries() }));

app.post("/research", { preHandler: requireAuth }, async (req, reply) => {
  if (authMode() === "none") {
    return reply.code(400).send({
      error:
        "No Claude credentials. Set CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY in the container environment.",
    });
  }
  const body = (req.body ?? {}) as { goal?: unknown };
  const goal = typeof body.goal === "string" ? body.goal.trim() : "";
  if (!goal) return reply.code(400).send({ error: "Provide a non-empty 'goal'." });
  if (goal.length > 4000) return reply.code(400).send({ error: "Goal is too long (max 4000 chars)." });

  const record = startRun(goal);
  return reply.code(202).send({ id: record.id });
});

app.get("/research/:id", { preHandler: requireAuth }, async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const live = runs.get(id);
  const record = live?.record ?? (await loadRecord(id));
  if (!record) return reply.code(404).send({ error: "not found" });
  return record;
});

// SSE stream of pipeline events. Replays the full event log first, then tails
// live events. Works for in-flight runs and (from disk) finished ones.
app.get("/research/:id/stream", { preHandler: requireAuth }, async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const live = runs.get(id);

  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const write = (ev: PipelineEvent) => {
    raw.write(`data: ${JSON.stringify(ev)}\n\n`);
  };

  // Not in memory: serve the persisted event log as a one-shot replay.
  if (!live) {
    const record = await loadRecord(id);
    if (!record) {
      raw.write(`data: ${JSON.stringify({ type: "error", ts: Date.now(), message: "run not found" })}\n\n`);
      raw.end();
      return;
    }
    for (const ev of record.events) write(ev);
    if (!record.events.some((e) => e.type === "done")) {
      write({ type: "done", ts: Date.now() });
    }
    raw.end();
    return;
  }

  // Replay buffered events, then subscribe to live ones (no await in between,
  // so no event can slip through the gap).
  for (const ev of live.record.events) write(ev);
  if (live.done) {
    raw.end();
    return;
  }

  const heartbeat = setInterval(() => {
    try {
      raw.write(": ping\n\n");
    } catch {
      /* ignore */
    }
  }, 15000);

  const sub = (ev: PipelineEvent) => {
    write(ev);
    if (ev.type === "done") {
      clearInterval(heartbeat);
      live.subscribers.delete(sub);
      try {
        raw.end();
      } catch {
        /* ignore */
      }
    }
  };
  live.subscribers.add(sub);

  req.raw.on("close", () => {
    clearInterval(heartbeat);
    live.subscribers.delete(sub);
  });
});

// ---- startup --------------------------------------------------------------

if (!config.appToken) {
  app.log.error(
    "APP_TOKEN is not set. Refusing to start an unprotected server. Set APP_TOKEN in your .env.",
  );
  process.exit(1);
}
if (authMode() === "none") {
  app.log.warn(
    "No Claude credentials found (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY). Research runs will fail until one is set.",
  );
} else {
  app.log.info(`Claude auth mode: ${authMode()}`);
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
