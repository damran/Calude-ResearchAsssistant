// The research pipeline: an explicit, deterministic orchestrator that pins each
// stage to a model so the expensive token bulk (fan-out research + fact-check)
// lands on cheaper models while Opus only plans and synthesizes.
//
//   1. plan        (Opus)        -> N subtopics + success criteria
//   2. research    (Sonnet x N)  -> per-subtopic findings with sources  [parallel]
//   3. evaluate    (Opus)        -> coverage check, optional 2nd round, key claims
//   4. fact-check  (Sonnet x M)  -> verify key claims                    [parallel]
//   5. synthesize  (Opus)        -> final cited report + confidence notes
//
// Sources are per-run: the web (WebSearch/WebFetch), a mounted workspace
// (/workspace, read-only or read-write+shell), and/or uploaded files.

import {
  addUsage,
  runAgent,
  READ_TOOLS,
  WEB_TOOLS,
  WRITE_TOOLS,
  type AgentResult,
  type AgentUsage,
} from "./agents.js";
import { config } from "./config.js";
import { WORKSPACE_PATH, dirTree, listUploads, loadRecord, outputsDir, uploadsDir } from "./store.js";
import { clamp, extractJson, mapLimit } from "./util.js";

export type Stage = "plan" | "research" | "evaluate" | "factcheck" | "synthesize";

export interface Subtopic {
  title: string;
  question: string;
}

export interface FactCheck {
  claim: string;
  verdict: "supported" | "unsupported" | "mixed" | "unclear";
  note: string;
  sources: string[];
}

export interface RunOptions {
  useWeb: boolean;
  workspace: "off" | "read" | "write";
  uploadCount: number;
}

export type PipelineEvent =
  | { type: "status"; ts: number; stage: Stage | "init"; message: string }
  | { type: "stage"; ts: number; stage: Stage; state: "start" | "done"; detail?: string }
  | { type: "plan"; ts: number; subtopics: Subtopic[]; successCriteria: string[] }
  | {
      type: "worker";
      ts: number;
      stage: "research" | "factcheck";
      index: number;
      label: string;
      state: "start" | "activity" | "done";
      detail?: string;
    }
  | { type: "usage"; ts: number; costUsd: number; inputTokens: number; outputTokens: number }
  | { type: "report"; ts: number; markdown: string }
  | { type: "error"; ts: number; message: string }
  | { type: "done"; ts: number };

export interface RunRecord {
  id: string;
  goal: string;
  status: "running" | "done" | "error";
  createdAt: string;
  finishedAt?: string;
  authMode: string;
  options: RunOptions;
  /** Set when this run refines an earlier one (feedback / follow-up). */
  parentId?: string;
  feedback?: string;
  subtopics: Subtopic[];
  factChecks: FactCheck[];
  reportMarkdown?: string;
  /** Persisted findings blob so a follow-up run can reuse this run's research. */
  findings?: string;
  usage: AgentUsage;
  costUsd: number;
  error?: string;
  events: PipelineEvent[];
}

export type Emit = (ev: PipelineEvent) => void;

const now = () => Date.now();

function accrue(record: RunRecord, res: AgentResult, emit: Emit): void {
  record.usage = addUsage(record.usage, res.usage);
  record.costUsd += res.costUsd;
  emit({
    type: "usage",
    ts: now(),
    costUsd: Number(record.costUsd.toFixed(4)),
    inputTokens: record.usage.input_tokens ?? 0,
    outputTokens: record.usage.output_tokens ?? 0,
  });
}

// Source context derived from the run options — drives tools, cwd, and prompts.
interface SourceCtx {
  researchTools: string[];
  factTools: string[];
  cwd?: string;
  localContext: string; // appended to research/fact-check prompts
  sourcesGuidance: string;
  citationHint: string;
}

function buildSourceCtx(record: RunRecord): SourceCtx {
  const opt = record.options;
  const workspaceOn = opt.workspace !== "off";
  const writable = opt.workspace === "write";
  const hasUploads = opt.uploadCount > 0;
  const hasLocal = workspaceOn || hasUploads;
  const upDir = uploadsDir(record.id);
  const outDir = outputsDir(record.id);

  const researchTools: string[] = [];
  const factTools: string[] = [];
  if (opt.useWeb) {
    researchTools.push(...WEB_TOOLS);
    factTools.push(...WEB_TOOLS);
  }
  if (hasLocal) {
    researchTools.push(...READ_TOOLS);
    factTools.push(...READ_TOOLS);
  }
  if (writable) researchTools.push(...WRITE_TOOLS);

  const localBits: string[] = [];
  if (workspaceOn) {
    localBits.push(
      `- A mounted workspace at ${WORKSPACE_PATH} (${writable ? "read-write — you may create/edit files and run shell commands here" : "read-only"}). Use Read/Grep/Glob to explore it.`,
    );
  }
  if (hasUploads) localBits.push(`- Uploaded files in ${upDir} (read-only). Use Read/Grep/Glob.`);
  if (writable) localBits.push(`- Save any files you generate for the user to ${outDir}.`);
  const localContext = localBits.length ? `\nLocal sources available to you:\n${localBits.join("\n")}\n` : "";

  let sourcesGuidance: string;
  if (opt.useWeb && hasLocal) sourcesGuidance = "Use web search/fetch AND the local sources listed below.";
  else if (opt.useWeb) sourcesGuidance = "Use web search and fetch.";
  else if (hasLocal) sourcesGuidance = "Use ONLY the local sources listed below — do not use the web.";
  else sourcesGuidance = "Use web search and fetch.";

  const citationHint = opt.useWeb && hasLocal
    ? "cite each finding with its source (a URL for web findings, or the file path for local ones)"
    : hasLocal && !opt.useWeb
      ? "cite each finding with its file path"
      : "cite each finding with its source URL";

  return {
    researchTools,
    factTools,
    cwd: workspaceOn ? WORKSPACE_PATH : hasUploads ? upDir : undefined,
    localContext,
    sourcesGuidance,
    citationHint,
  };
}

// ---------------------------------------------------------------------------
// Stage 1 — plan
// ---------------------------------------------------------------------------

const PLAN_SYSTEM =
  "You are the lead researcher planning a deep-research investigation. " +
  "Decompose the user's goal into independent, parallelizable subtopics that together fully cover it. " +
  "Each subtopic is handed to a separate worker with NO other context, so make each one self-contained and framed as a precise question. " +
  "Respond with JSON only — no prose, no code fences.";

async function planStage(
  goal: string,
  fanout: number,
  localListing: string,
): Promise<{ subtopics: Subtopic[]; successCriteria: string[]; raw: AgentResult }> {
  const raw = await runAgent({
    model: config.models.plan,
    systemPrompt: PLAN_SYSTEM,
    maxTurns: 2,
    prompt:
      `Research goal:\n${goal}\n${localListing}\n` +
      `Produce exactly ${fanout} subtopics. Do not use any tools.\n` +
      `JSON shape:\n` +
      `{"subtopics":[{"title":"short label","question":"precise self-contained question"}],` +
      `"successCriteria":["what a complete answer must include"]}`,
  });

  const parsed = extractJson<{ subtopics?: Subtopic[]; successCriteria?: string[] }>(raw.text);
  let subtopics = Array.isArray(parsed?.subtopics) ? parsed!.subtopics : [];
  subtopics = subtopics
    .filter((s) => s && typeof s.question === "string" && s.question.trim())
    .slice(0, fanout)
    .map((s) => ({ title: String(s.title ?? s.question).slice(0, 120), question: String(s.question) }));
  if (subtopics.length === 0) subtopics = [{ title: "Direct investigation", question: goal }];

  const successCriteria = Array.isArray(parsed?.successCriteria)
    ? parsed!.successCriteria.map(String).slice(0, 10)
    : [];
  return { subtopics, successCriteria, raw };
}

// ---------------------------------------------------------------------------
// Stage 1b — refine plan (when this run is feedback/follow-up on a prior run)
// ---------------------------------------------------------------------------

const REFINE_SYSTEM =
  "You are the lead researcher revising an existing report based on user feedback. " +
  "Decide what additional research (if any) is needed to address the feedback, and note how the report should change. " +
  "Respond with JSON only — no prose, no code fences.";

async function refinePlanStage(
  goal: string,
  feedback: string,
  parentReport: string,
  fanout: number,
): Promise<{ subtopics: Subtopic[]; revisionNotes: string; raw: AgentResult }> {
  const raw = await runAgent({
    model: config.models.plan,
    systemPrompt: REFINE_SYSTEM,
    maxTurns: 2,
    prompt:
      `Original goal:\n${goal}\n\nUser feedback on the existing report:\n${feedback}\n\n` +
      `Existing report:\n${parentReport.slice(0, 12000)}\n\n` +
      `Do not use tools. Decide what NEW research is needed to address the feedback (it may be none if the ` +
      `feedback is purely editorial). JSON shape:\n` +
      `{"followups":[{"title":"short label","question":"precise self-contained question"}],` +
      `"revisionNotes":"how the report should change to address the feedback"}\n` +
      `At most ${fanout} followups.`,
  });

  const parsed = extractJson<{ followups?: Subtopic[]; revisionNotes?: string }>(raw.text) ?? {};
  const subtopics = Array.isArray(parsed.followups)
    ? parsed.followups
        .filter((s) => s && typeof s.question === "string" && s.question.trim())
        .slice(0, fanout)
        .map((s) => ({ title: String(s.title ?? s.question).slice(0, 120), question: String(s.question) }))
    : [];
  return { subtopics, revisionNotes: typeof parsed.revisionNotes === "string" ? parsed.revisionNotes : "", raw };
}

// ---------------------------------------------------------------------------
// Stage 2 / re-round — research worker
// ---------------------------------------------------------------------------

const RESEARCH_SYSTEM =
  "You are a research worker investigating ONE subtopic. Gather facts from the sources you are given. " +
  "Prefer primary and authoritative sources, note dates, and flag where sources disagree. " +
  "Be concise and factual. Every nontrivial claim must cite a real source — never invent sources. " +
  "IMPORTANT: you have a limited number of turns. Do NOT spend all turns searching — after 2-3 searches, " +
  "write your findings brief immediately. It is better to deliver partial findings than to run out of turns.";

async function researchWorker(
  goal: string,
  sub: Subtopic,
  index: number,
  ctx: SourceCtx,
  emit: Emit,
): Promise<{ text: string; res: AgentResult }> {
  emit({ type: "worker", ts: now(), stage: "research", index, label: sub.title, state: "start" });
  let res: AgentResult;
  try {
    res = await runAgent({
      model: config.models.research,
      systemPrompt: RESEARCH_SYSTEM,
      allowedTools: ctx.researchTools,
      cwd: ctx.cwd,
      maxTurns: clamp(config.researchMaxTurns, 2, 20),
      prompt:
        `Overall goal (for context only):\n${goal}\n\n` +
        `Your subtopic: ${sub.title}\nQuestion: ${sub.question}\n\n` +
        `${ctx.sourcesGuidance}${ctx.localContext}\n` +
        `Write a findings brief in markdown after no more than 3 searches:\n` +
        `- 3 to 8 bullet points of concrete findings, each ${ctx.citationHint}\n` +
        `- then a "Sources:" line listing what you used\n` +
        `Do not fabricate sources. If evidence is thin or conflicting, say so. ` +
        `Write your brief as soon as you have enough data — do not wait.`,
      onActivity: (a) =>
        emit({
          type: "worker",
          ts: now(),
          stage: "research",
          index,
          label: sub.title,
          state: "activity",
          detail: `${a.tool}${a.detail ? ": " + a.detail.slice(0, 100) : ""}`,
        }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit({ type: "worker", ts: now(), stage: "research", index, label: sub.title, state: "done", detail: "(error)" });
    const empty: AgentResult = { text: "", ok: false, subtype: "error", usage: {}, costUsd: 0, model: config.models.research };
    return { text: `_Worker error for "${sub.title}": ${msg.slice(0, 300)}_`, res: empty };
  }
  emit({
    type: "worker",
    ts: now(),
    stage: "research",
    index,
    label: sub.title,
    state: "done",
    detail: res.ok ? undefined : `(${res.subtype})`,
  });
  return { text: res.ok && res.text ? res.text : `_No findings (${res.subtype}) for "${sub.title}"._`, res };
}

function formatFindings(items: { sub: Subtopic; text: string }[]): string {
  return items
    .map((it, i) => `### Subtopic ${i + 1}: ${it.sub.title}\nQuestion: ${it.sub.question}\n\n${it.text}`)
    .join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Stage 3 — evaluate (coverage + key claims + optional follow-up round)
// ---------------------------------------------------------------------------

const EVAL_SYSTEM =
  "You are the research editor. Given the goal and the collected findings, judge how well the goal is covered, " +
  "name any important gaps, and extract the most important INDEPENDENTLY CHECKABLE factual claims for verification. " +
  "Respond with JSON only — no prose, no code fences.";

interface EvalResult {
  coverage: "good" | "partial";
  gaps: string[];
  followups: Subtopic[];
  keyClaims: string[];
}

async function evaluateStage(
  goal: string,
  findings: string,
  fanout: number,
  allowFollowups: boolean,
): Promise<{ evalResult: EvalResult; raw: AgentResult }> {
  const raw = await runAgent({
    model: config.models.evaluate,
    systemPrompt: EVAL_SYSTEM,
    maxTurns: 2,
    prompt:
      `Goal:\n${goal}\n\nCollected findings:\n${findings}\n\n` +
      `Do not use tools. JSON shape:\n` +
      `{"coverage":"good|partial",` +
      `"gaps":["short description"],` +
      `"followups":[{"title":"...","question":"..."}],` +
      `"keyClaims":["a specific, checkable factual claim drawn from the findings"]}\n` +
      `Include followups ONLY for important gaps worth another round` +
      `${allowFollowups ? ` (at most ${fanout})` : ` — but return [] for followups now`}. ` +
      `Return at most 6 keyClaims.`,
  });

  const parsed = extractJson<Partial<EvalResult>>(raw.text) ?? {};
  const evalResult: EvalResult = {
    coverage: parsed.coverage === "good" ? "good" : "partial",
    gaps: Array.isArray(parsed.gaps) ? parsed.gaps.map(String).slice(0, 10) : [],
    followups:
      allowFollowups && Array.isArray(parsed.followups)
        ? parsed.followups
            .filter((s) => s && typeof s.question === "string" && s.question.trim())
            .slice(0, fanout)
            .map((s) => ({ title: String(s.title ?? s.question).slice(0, 120), question: String(s.question) }))
        : [],
    keyClaims: Array.isArray(parsed.keyClaims)
      ? parsed.keyClaims.map(String).map((c) => c.trim()).filter(Boolean).slice(0, 6)
      : [],
  };
  return { evalResult, raw };
}

// ---------------------------------------------------------------------------
// Stage 4 — fact-check worker
// ---------------------------------------------------------------------------

const FACTCHECK_SYSTEM =
  "You are a fact-checker verifying a single factual claim against independent sources. " +
  "Be skeptical: do not trust the claim's own phrasing — find corroborating or contradicting evidence. " +
  "Respond with JSON only — no prose, no code fences.";

async function factCheckWorker(
  claim: string,
  index: number,
  ctx: SourceCtx,
  emit: Emit,
): Promise<{ fc: FactCheck; res: AgentResult }> {
  const label = claim.slice(0, 80);
  emit({ type: "worker", ts: now(), stage: "factcheck", index, label, state: "start" });
  let res: AgentResult;
  try {
    res = await runAgent({
      model: config.models.factcheck,
      systemPrompt: FACTCHECK_SYSTEM,
      allowedTools: ctx.factTools,
      cwd: ctx.cwd,
      maxTurns: clamp(config.factcheckMaxTurns, 2, 20),
      prompt:
        `Claim to verify:\n"${claim}"\n\n` +
        `${ctx.sourcesGuidance}${ctx.localContext}\n` +
        `Do 1-2 searches then respond immediately with JSON — do not keep searching.\n` +
        `JSON shape:\n` +
        `{"verdict":"supported|unsupported|mixed|unclear","note":"one-sentence justification","sources":["url or file path"]}`,
      onActivity: (a) =>
        emit({
          type: "worker",
          ts: now(),
          stage: "factcheck",
          index,
          label,
          state: "activity",
          detail: `${a.tool}${a.detail ? ": " + a.detail.slice(0, 100) : ""}`,
        }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit({ type: "worker", ts: now(), stage: "factcheck", index, label, state: "done", detail: "(error)" });
    const empty: AgentResult = { text: "", ok: false, subtype: "error", usage: {}, costUsd: 0, model: config.models.factcheck };
    const fc: FactCheck = { claim, verdict: "unclear", note: `Worker failed: ${msg.slice(0, 120)}`, sources: [] };
    return { fc, res: empty };
  }

  const parsed = extractJson<Partial<FactCheck>>(res.text) ?? {};
  const verdict = ["supported", "unsupported", "mixed", "unclear"].includes(String(parsed.verdict))
    ? (parsed.verdict as FactCheck["verdict"])
    : "unclear";
  const fc: FactCheck = {
    claim,
    verdict,
    note: typeof parsed.note === "string" ? parsed.note : "",
    sources: Array.isArray(parsed.sources) ? parsed.sources.map(String).slice(0, 8) : [],
  };
  emit({ type: "worker", ts: now(), stage: "factcheck", index, label, state: "done", detail: verdict });
  return { fc, res };
}

// ---------------------------------------------------------------------------
// Stage 5 — synthesize
// ---------------------------------------------------------------------------

const SYNTH_SYSTEM =
  "You are the lead researcher writing the final report. Use ONLY the provided findings and fact-check results — " +
  "do not introduce new facts or sources. Lead with the answer; write for a smart reader who wants the conclusion first.";

interface RefineCtx {
  feedback: string;
  parentReport: string;
  revisionNotes: string;
}

async function synthesizeStage(
  goal: string,
  findings: string,
  factChecks: FactCheck[],
  refine?: RefineCtx,
): Promise<AgentResult> {
  const fcText = factChecks.length
    ? factChecks.map((f) => `- [${f.verdict}] ${f.claim}${f.note ? ` — ${f.note}` : ""}`).join("\n")
    : "(no claims were fact-checked)";
  const refineBlock = refine
    ? `\nThis is a REVISION of an earlier report. Address the user's feedback: keep what is still valid, ` +
      `correct what the feedback flags, and fold in the new findings.\n` +
      `User feedback:\n${refine.feedback}\n\nRevision notes:\n${refine.revisionNotes}\n\n` +
      `Previous report:\n${refine.parentReport.slice(0, 16000)}\n`
    : "";
  return runAgent({
    model: config.models.synth,
    systemPrompt: SYNTH_SYSTEM,
    maxTurns: 2,
    prompt:
      `Goal:\n${goal}\n${refineBlock}\nFindings:\n${findings}\n\nFact-check results:\n${fcText}\n\n` +
      `Do not use tools. Write a markdown report with:\n` +
      `1. A short, direct answer to the goal up front.\n` +
      `2. Organized sections covering the findings, with inline source links/paths.\n` +
      `3. A "Sources" list of what was referenced.\n` +
      `4. A final "Confidence & caveats" section that explicitly flags anything fact-checking marked ` +
      `unsupported, mixed, or unclear, and any gaps still open.`,
  });
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runPipeline(record: RunRecord, emit: Emit): Promise<void> {
  const goal = record.goal;
  const fanout = clamp(config.fanoutWidth, 1, 12);
  const maxRounds = clamp(config.maxRounds, 1, 4);
  const ctx = buildSourceCtx(record);

  const refine = Boolean(record.parentId && record.feedback);
  let priorFindings = "";
  let parentReport = "";
  let revisionNotes = "";

  try {
    // 1. Plan — a fresh decomposition, or a feedback-driven refine plan that
    //    reads the prior report.
    emit({ type: "stage", ts: now(), stage: "plan", state: "start" });
    let subtopics: Subtopic[];

    if (refine) {
      const parent = await loadRecord(record.parentId as string);
      parentReport = parent?.reportMarkdown ?? "";
      priorFindings = parent?.findings ?? "";
      emit({ type: "status", ts: now(), stage: "plan", message: `Refining a previous report with your feedback (${config.models.plan})…` });
      const rp = await refinePlanStage(goal, record.feedback as string, parentReport, fanout);
      accrue(record, rp.raw, emit);
      revisionNotes = rp.revisionNotes;
      subtopics = rp.subtopics;
      record.subtopics = subtopics;
      emit({ type: "plan", ts: now(), subtopics, successCriteria: [] });
      emit({
        type: "stage",
        ts: now(),
        stage: "plan",
        state: "done",
        detail: subtopics.length ? `${subtopics.length} follow-up topics` : "editorial revision (no new research)",
      });
    } else {
      emit({ type: "status", ts: now(), stage: "plan", message: `Planning ${fanout} research angles with ${config.models.plan}…` });
      let localListing = "";
      if (record.options.workspace !== "off") {
        localListing += `\nWorkspace files (${WORKSPACE_PATH}):\n${await dirTree(WORKSPACE_PATH)}\n`;
      }
      if (record.options.uploadCount > 0) {
        const ups = await listUploads(record.id);
        localListing += `\nUploaded files (${uploadsDir(record.id)}):\n${ups.join("\n") || "(none)"}\n`;
      }
      const plan = await planStage(goal, fanout, localListing);
      accrue(record, plan.raw, emit);
      subtopics = plan.subtopics;
      record.subtopics = subtopics;
      emit({ type: "plan", ts: now(), subtopics, successCriteria: plan.successCriteria });
      emit({ type: "stage", ts: now(), stage: "plan", state: "done", detail: `${subtopics.length} subtopics` });
    }

    // 2. Research (round 1) + optional follow-up rounds driven by evaluate.
    //    In refine mode, prior findings are folded in alongside new ones.
    const collected: { sub: Subtopic; text: string }[] = [];
    const combinedFindings = () =>
      [priorFindings, formatFindings(collected)].map((s) => s.trim()).filter(Boolean).join("\n\n---\n\n");
    let round = 1;
    let toResearch = subtopics;
    let evalResult: EvalResult = { coverage: "partial", gaps: [], followups: [], keyClaims: [] };

    while (toResearch.length > 0 && round <= maxRounds) {
      emit({ type: "stage", ts: now(), stage: "research", state: "start", detail: `round ${round}` });
      emit({
        type: "status",
        ts: now(),
        stage: "research",
        message: `Round ${round}: ${toResearch.length} ${config.models.research} workers (≤${config.workerConcurrency} in parallel)…`,
      });
      const subs = toResearch;
      const results = await mapLimit(subs, config.workerConcurrency, (sub, i) => researchWorker(goal, sub, i, ctx, emit));
      results.forEach((r, i) => {
        accrue(record, r.res, emit);
        collected.push({ sub: subs[i] as Subtopic, text: r.text });
      });
      emit({ type: "stage", ts: now(), stage: "research", state: "done", detail: `round ${round}` });

      // 3. Evaluate — coverage + claims, and decide whether to run another round
      const allowFollowups = round < maxRounds;
      emit({ type: "stage", ts: now(), stage: "evaluate", state: "start" });
      emit({ type: "status", ts: now(), stage: "evaluate", message: `Assessing coverage with ${config.models.evaluate}…` });
      const evaluation = await evaluateStage(goal, combinedFindings(), fanout, allowFollowups);
      accrue(record, evaluation.raw, emit);
      evalResult = evaluation.evalResult;
      emit({
        type: "stage",
        ts: now(),
        stage: "evaluate",
        state: "done",
        detail: `coverage: ${evalResult.coverage}; ${evalResult.followups.length} follow-ups; ${evalResult.keyClaims.length} claims`,
      });

      if (evalResult.coverage === "good" || evalResult.followups.length === 0) break;
      toResearch = evalResult.followups;
      round += 1;
    }

    const findings = combinedFindings();
    record.findings = findings; // persisted so a follow-up run can reuse it

    // 4. Fact-check key claims in parallel
    if (evalResult.keyClaims.length > 0) {
      emit({ type: "stage", ts: now(), stage: "factcheck", state: "start" });
      emit({
        type: "status",
        ts: now(),
        stage: "factcheck",
        message: `Verifying ${evalResult.keyClaims.length} claims with ${config.models.factcheck}…`,
      });
      const checks = await mapLimit(evalResult.keyClaims, config.workerConcurrency, (claim, i) =>
        factCheckWorker(claim, i, ctx, emit),
      );
      checks.forEach((c) => {
        accrue(record, c.res, emit);
        record.factChecks.push(c.fc);
      });
      emit({ type: "stage", ts: now(), stage: "factcheck", state: "done", detail: `${record.factChecks.length} checked` });
    } else {
      emit({ type: "status", ts: now(), stage: "factcheck", message: "No checkable claims surfaced; skipping fact-check." });
    }

    // 5. Synthesize the final report
    emit({ type: "stage", ts: now(), stage: "synthesize", state: "start" });
    emit({ type: "status", ts: now(), stage: "synthesize", message: `Writing the report with ${config.models.synth}…` });
    const synth = await synthesizeStage(
      goal,
      findings,
      record.factChecks,
      refine ? { feedback: record.feedback as string, parentReport, revisionNotes } : undefined,
    );
    accrue(record, synth, emit);
    record.reportMarkdown = synth.ok && synth.text ? synth.text : `# Report incomplete\n\nThe synthesis step failed (${synth.subtype}).`;
    emit({ type: "stage", ts: now(), stage: "synthesize", state: "done" });
    emit({ type: "report", ts: now(), markdown: record.reportMarkdown });

    record.status = "done";
    record.finishedAt = new Date().toISOString();
    emit({ type: "done", ts: now() });
  } catch (err) {
    record.status = "error";
    record.finishedAt = new Date().toISOString();
    record.error = err instanceof Error ? err.message : String(err);
    emit({ type: "error", ts: now(), message: record.error });
    emit({ type: "done", ts: now() });
  }
}
