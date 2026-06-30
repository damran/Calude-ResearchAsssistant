// HTTP server: serves the UI, starts research runs (with optional uploads and a
// mounted workspace), and streams live progress over SSE. Runs are
// fire-and-forget; their event log is replayed to any client that connects (or
// reconnects) mid-run, and persisted to disk on completion.

import { createReadStream, createWriteStream, existsSync } from "node:fs";
import path from "node:path";
import { pipeline as streamPipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import { requireAuth } from "./auth.js";
import { authMode, config } from "./config.js";
import { runPipeline, type PipelineEvent, type RunOptions, type RunRecord } from "./pipeline.js";
import {
  ensureRunDirs,
  listOutputs,
  listSummaries,
  loadRecord,
  outputPath,
  safeName,
  saveRecord,
  uploadsDir,
  workspaceAvailable,
} from "./store.js";
import { newId } from "./util.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "..", "public");

interface LiveRun {
  record: RunRecord;
  subscribers: Set<(ev: PipelineEvent) => void>;
  done: boolean;
}

const runs = new Map<string, LiveRun>();

function makeRecord(id: string, goal: string, options: RunOptions): RunRecord {
  return {
    id,
    goal,
    status: "running",
    createdAt: new Date().toISOString(),
    authMode: authMode(),
    options,
    subtopics: [],
    factChecks: [],
    usage: {},
    costUsd: 0,
    events: [],
  };
}

function launch(record: RunRecord): void {
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
}

const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });

await app.register(fastifyMultipart, {
  limits: { fileSize: 25 * 1024 * 1024, files: 20, fields: 20 },
});
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
  workspaceAvailable: workspaceAvailable(),
}));

app.get("/api/runs", { preHandler: requireAuth }, async () => ({ runs: await listSummaries() }));

// Start a run. Accepts multipart/form-data: fields goal, useWeb, workspace
// (off|read|write) and any number of file uploads.
app.post("/research", { preHandler: requireAuth }, async (req, reply) => {
  if (authMode() === "none") {
    return reply.code(400).send({
      error:
        "No Claude credentials. Set CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY in the container environment.",
    });
  }

  const id = newId();
  await ensureRunDirs(id);

  let goal = "";
  let useWeb = true;
  let workspace: RunOptions["workspace"] = "off";
  let uploadCount = 0;

  try {
    if (req.isMultipart()) {
      for await (const part of req.parts()) {
        if (part.type === "file") {
          const name = safeName(part.filename || `upload-${uploadCount}`) || `upload-${uploadCount}`;
          await streamPipeline(part.file, createWriteStream(path.join(uploadsDir(id), name)));
          if (part.file.truncated) {
            return reply.code(413).send({ error: `File ${name} exceeds the 25 MB limit.` });
          }
          uploadCount++;
        } else {
          const value = String(part.value ?? "");
          if (part.fieldname === "goal") goal = value.trim();
          else if (part.fieldname === "useWeb") useWeb = value === "true";
          else if (part.fieldname === "workspace" && ["off", "read", "write"].includes(value)) {
            workspace = value as RunOptions["workspace"];
          }
        }
      }
    } else {
      const body = (req.body ?? {}) as { goal?: unknown; useWeb?: unknown; workspace?: unknown };
      if (typeof body.goal === "string") goal = body.goal.trim();
      if (typeof body.useWeb === "boolean") useWeb = body.useWeb;
      if (typeof body.workspace === "string" && ["off", "read", "write"].includes(body.workspace)) {
        workspace = body.workspace as RunOptions["workspace"];
      }
    }
  } catch (e) {
    return reply.code(400).send({ error: `Failed to read request: ${(e as Error).message}` });
  }

  if (!goal) return reply.code(400).send({ error: "Provide a non-empty 'goal'." });
  if (goal.length > 4000) return reply.code(400).send({ error: "Goal is too long (max 4000 chars)." });

  // Workspace can only be used if one is actually mounted.
  if (workspace !== "off" && !workspaceAvailable()) workspace = "off";
  // A run needs at least one source.
  if (!useWeb && workspace === "off" && uploadCount === 0) useWeb = true;

  const record = makeRecord(id, goal, { useWeb, workspace, uploadCount });
  launch(record);
  return reply.code(202).send({ id });
});

app.get("/research/:id", { preHandler: requireAuth }, async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const record = runs.get(id)?.record ?? (await loadRecord(id));
  if (!record) return reply.code(404).send({ error: "not found" });
  return record;
});

// List downloadable artifacts the run produced (files agents wrote to outputs/).
app.get("/research/:id/files", { preHandler: requireAuth }, async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!runs.has(id) && !(await loadRecord(id))) return reply.code(404).send({ error: "not found" });
  return { files: await listOutputs(id) };
});

// Download a generated artifact.
app.get("/research/:id/files/:name", { preHandler: requireAuth }, async (req, reply) => {
  const { id, name } = req.params as { id: string; name: string };
  const p = outputPath(id, name);
  if (!p || !existsSync(p)) return reply.code(404).send({ error: "not found" });
  reply.header("Content-Disposition", `attachment; filename="${safeName(name)}"`);
  return reply.send(createReadStream(p));
});

// Download the report as markdown or JSON.
app.get("/research/:id/report.:ext", { preHandler: requireAuth }, async (req, reply) => {
  const { id, ext } = req.params as { id: string; ext: string };
  const record = runs.get(id)?.record ?? (await loadRecord(id));
  if (!record) return reply.code(404).send({ error: "not found" });
  if (ext === "json") {
    reply.header("Content-Disposition", `attachment; filename="report-${id}.json"`);
    return reply.type("application/json").send(JSON.stringify(record, null, 2));
  }
  if (ext === "md") {
    const md = record.reportMarkdown ?? "# Report not ready";
    reply.header("Content-Disposition", `attachment; filename="report-${id}.md"`);
    return reply.type("text/markdown; charset=utf-8").send(`# ${record.goal}\n\n---\n\n${md}`);
  }
  return reply.code(404).send({ error: "unknown format" });
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

  if (!live) {
    const record = await loadRecord(id);
    if (!record) {
      raw.write(`data: ${JSON.stringify({ type: "error", ts: Date.now(), message: "run not found" })}\n\n`);
      raw.end();
      return;
    }
    for (const ev of record.events) write(ev);
    if (!record.events.some((e) => e.type === "done")) write({ type: "done", ts: Date.now() });
    raw.end();
    return;
  }

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
  app.log.error("APP_TOKEN is not set. Refusing to start an unprotected server. Set APP_TOKEN in your .env.");
  process.exit(1);
}
if (authMode() === "none") {
  app.log.warn(
    "No Claude credentials found (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY). Research runs will fail until one is set.",
  );
} else {
  app.log.info(`Claude auth mode: ${authMode()}; workspace mounted: ${workspaceAvailable()}`);
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
