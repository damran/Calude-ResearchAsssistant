# Research Assistant

A self-hosted, **model-tiered deep-research assistant** built on the **Claude Agent SDK** (headless
Claude — the same engine as `claude -p`). You give it a goal; it plans the research, fans out parallel
worker agents to gather and verify evidence, and writes a cited report — streaming progress to a simple
web UI the whole way. It runs in Docker and is driven by your Claude subscription.

The point is **cost**: running "deep research" as a swarm of Opus agents burns subscription usage
fast, because the bulk of the tokens is spent by the many fan-out workers. This tool puts Opus only
where it adds the most value (planning and writing) and runs the token-heavy bulk on cheaper models.

- [What it is](#what-it-is)
- [Design decisions (and why)](#design-decisions-and-why)
- [How it works](#how-it-works)
- [Setup](#setup)
- [Configuration reference](#configuration-reference)
- [Sources & outputs](#sources--outputs)
- [Cost & usage](#cost--usage)
- [Security notes](#security-notes)
- [Project layout](#project-layout)
- [Status & limitations](#status--limitations)

---

## What it is

A single, self-hosted web app:

- **Input:** a research goal (and optionally: web on/off, a mounted folder to read, files to upload).
- **Output:** a cited markdown report with a confidence/caveats section, downloadable as `.md`/`.json`,
  plus any files the agents generated — and a **follow-up box** to refine the report with feedback.
- **Engine:** the Claude Agent SDK in headless mode, authenticated with your Claude subscription.
- **Runtime:** one TypeScript/Node service in a Docker container; reports persist to a data volume.

It is a **single-user, personal** tool — gated by one shared secret, not hardened for the public internet.

---

## Design decisions (and why)

| Decision | Why |
| --- | --- |
| **Claude Agent SDK (headless)** as the engine, not the raw Messages API | The SDK runs the agentic web-search/tool loop, prompt caching, and context management for us; lets each call pick its model; and — crucially — can authenticate with a Claude subscription headlessly. |
| **Subscription OAuth** auth by default (API key optional) | Runs draw from your Max/Pro plan's usage limits instead of pay-per-token credits — the single biggest cost lever. `claude setup-token` mints a ~1-year token; no repeated logins. |
| **Model tiering** — Opus plans + synthesizes, Sonnet does the bulk | Planning and final writing are a small share of tokens but high-value → Opus. Fan-out research and fact-checking are the token-heavy bulk → Sonnet (or Haiku). This is the core saving. |
| **Explicit pipeline orchestrator**, not one self-directing agent | A fixed plan→research→evaluate→fact-check→synthesize pipeline gives predictable cost, predictable fan-out width, clean per-stage progress for the UI, and bounded depth. A single agent deciding its own subagents is less controllable. |
| **TypeScript + Node**, single runtime | The Agent SDK needs Node regardless, so a Node backend avoids a second runtime and keeps the Docker image simple. |
| **Single shared secret** for app login (not Google OAuth) | For a one-user tool, a shared `APP_TOKEN` (remembered in the browser, so you type it once) is the simplest thing that's safe. Google OIDC would mean running your own OAuth client for marginal benefit. |
| **Filesystem persistence, no database** | One JSON + markdown file per run under a Docker volume. Nothing to operate. |
| **Docker, non-root** | Portable and reproducible. Runs as the `node` user because the SDK's headless permission mode requires non-root. |
| **Bounded fan-out & rounds** | Caps on concurrent workers and research rounds keep a single run from blowing through the subscription's 5-hour rolling limit. |

---

## How it works

### The pipeline

Each stage is a headless Agent SDK call pinned to a model:

```
goal ─► Plan(Opus) ─► Research × N (Sonnet, parallel) ─► Evaluate(Opus)
                                   ▲                          │ gaps?
                                   └──────── round 2 ◄────────┘
                          ─► Fact-check × M (Sonnet, parallel) ─► Synthesize(Opus) ─► report
```

1. **Plan (Opus)** — decompose the goal into `FANOUT_WIDTH` self-contained subtopics + success criteria.
2. **Research (Sonnet × N, parallel)** — each worker investigates one subtopic with the run's sources,
   returns a findings brief with citations. Concurrency is capped by `WORKER_CONCURRENCY`.
3. **Evaluate (Opus)** — assess coverage, extract the most important checkable claims, and (up to
   `MAX_ROUNDS`) optionally fire one more targeted research round to close gaps.
4. **Fact-check (Sonnet × M, parallel)** — verify each key claim against independent sources; mark it
   supported / unsupported / mixed / unclear.
5. **Synthesize (Opus)** — write the final cited report, with a "Confidence & caveats" section that
   flags anything fact-checking didn't support and any gaps left open.

Progress streams to the browser over **SSE**; the full event log is replayed to any client that
connects or reconnects mid-run. On completion the run is saved to disk.

### Sources

Each run picks its sources in the UI; the agents' toolset is assembled per run accordingly:

- **Web** — `WebSearch` / `WebFetch`.
- **Workspace** — a host/WSL folder mounted at `/workspace`, in one of two modes:
  - **read-only** — agents `Read`/`Grep`/`Glob` it as a source corpus.
  - **read-write + shell** — agents may also `Write`/`Edit` and run `Bash` in it. ⚠️ see [Security notes](#security-notes).
- **Uploads** — files attached to a single run; they land in that run's read-only `uploads/` dir.

When local sources are present, the planner is handed a directory listing so it plans around your files.

### Feedback / follow-ups

Under any finished report there's a **Refine / follow up** box. Submitting feedback (e.g. "go deeper on
pricing" or "recheck the claim about X") spawns a **linked run** that re-reads the prior report and its
findings, does any targeted extra research, and writes a revised report. Follow-ups are marked `↳` in
Recent runs, and past runs are always re-openable.

### Auth

Every route except the health check requires the shared `APP_TOKEN`. The browser sends it as a header
for API calls and as a `?token=` query param for the SSE stream and download links (since `EventSource`
and `<a download>` can't set headers). The server **refuses to start** without an `APP_TOKEN`.

---

## Setup

### Prerequisites

- **Docker** (with Compose).
- A **Claude Pro / Max / Team / Enterprise** subscription (default), or an Anthropic API key.
- Node.js once, on any machine with a browser, to mint the subscription token.

### 1. Get the code

```bash
git clone https://github.com/damran/Calude-ResearchAsssistant.git
cd Calude-ResearchAsssistant
```

### 2. Mint a subscription token (one time)

On a machine with a browser:

```bash
npm install -g @anthropic-ai/claude-code   # if you don't already have it
claude setup-token                         # OAuth flow → prints a ~1-year token
```

Copy the token. (Docs: <https://code.claude.com/docs/en/authentication> → "Generate a long-lived token".)

> **Using an API key instead?** Skip this; put `ANTHROPIC_API_KEY=...` in `.env` and leave
> `CLAUDE_CODE_OAUTH_TOKEN` blank. Don't set both — an API key takes precedence and switches billing to
> pay-per-token.

### 3. Configure

```bash
cp .env.example .env
```

Edit `.env`:

- `CLAUDE_CODE_OAUTH_TOKEN=` — paste the token from step 2.
- `APP_TOKEN=` — a long random string; this is the web-UI password (required).
- `WORKSPACE_DIR=` — optional: a host/WSL folder to expose to the agents (defaults to `./workspace`).
- Tune `FANOUT_WIDTH`, `MAX_ROUNDS`, `WORKER_CONCURRENCY`, and the per-stage `*_MODEL` vars as desired.

### 4. Run

```bash
docker compose up --build
```

Open <http://localhost:8787>, sign in with your `APP_TOKEN` (the browser remembers it — you enter it
once), type a goal, and watch the agents work. Reports persist in the `ra-data` volume.

### Local development (without Docker)

Requires Node ≥ 20.

```bash
npm install
# set CLAUDE_CODE_OAUTH_TOKEN + APP_TOKEN in your shell env
npm run dev          # tsx watch
# or: npm run build && npm start
npm run typecheck    # tsc, no emit
```

---

## Configuration reference

All via `.env`.

| Var | Default | Meaning |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Subscription token from `claude setup-token` |
| `ANTHROPIC_API_KEY` | — | Pay-per-token alternative (leave blank if using the token) |
| `APP_TOKEN` | — | Shared secret for the web UI (**required** — server won't start without it) |
| `HOST` / `PORT` | `0.0.0.0` / `8787` | Bind address / port (keep `0.0.0.0` for Docker) |
| `PLAN_MODEL` | `opus` | Planner model (alias or full id, e.g. `claude-opus-4-8`) |
| `RESEARCH_MODEL` | `sonnet` | Research worker model |
| `EVAL_MODEL` | `opus` | Evaluator model |
| `FACTCHECK_MODEL` | `sonnet` | Fact-checker model (set `haiku` if available to your plan) |
| `SYNTH_MODEL` | `opus` | Synthesis model |
| `FANOUT_WIDTH` | `4` | Number of research subtopics |
| `MAX_ROUNDS` | `2` | Max research rounds (1 = no follow-up; 2 = one targeted follow-up) |
| `WORKER_CONCURRENCY` | `4` | Max worker agents running at once |
| `RESEARCH_MAX_TURNS` / `FACTCHECK_MAX_TURNS` | `8` / `6` | Per-agent tool-use budget |
| `WORKSPACE_DIR` *(compose)* | `./workspace` | Host/WSL folder mounted at `/workspace` for the agents |
| `DATA_DIR` | `./data` | Where run records, uploads, and outputs are written |

Model aliases (`opus`/`sonnet`/`haiku`) track the latest; pin a full id (`claude-opus-4-8`,
`claude-sonnet-4-6`, `claude-haiku-4-5`) if you want it fixed.

---

## Sources & outputs

You can combine sources in a run. Set the mounted folder with `WORKSPACE_DIR` in `.env`; on Windows/WSL2
that can be a Windows path (`C:\Users\you\docs`), a `/mnt/c/...` path, or a `\\wsl$\...` path.

**Outputs:** every run's report is downloadable as `.md` / `.json` from the UI. In read-write mode,
files the agents save to the run's `outputs/` directory appear as downloadable artifacts. Each run lives
under `data/runs/<id>` (`.json` record, `.md` report, `uploads/`, `outputs/`).

---

## Cost & usage

- **Subscription auth** means runs count against your plan's limits, not credits. `WORKER_CONCURRENCY`
  and `MAX_ROUNDS` bound how hard one run hits the 5-hour rolling limit.
- **Model tiering** does the heavy lifting: workers on Sonnet (~$3/$15 per MTok) or Haiku (~$1/$5) vs
  Opus (~$5/$25); the Opus planning + synthesis tokens are a small fraction of a run.
- The UI shows an **estimated** equivalent USD cost (the SDK estimates it from token usage even on a
  subscription) plus running token counts.

---

## Security notes

- The whole app is gated by `APP_TOKEN`; the server won't start without one. Use a long random value.
- The token is sent as a `?token=` query param on the SSE stream and download links (browsers can't set
  headers there). Keep the app on a trusted network (LAN / VPN / behind a reverse proxy) — it isn't
  hardened for the public internet.
- The OAuth token is your personal subscription credential. It lives only in `.env` (gitignored) and the
  container env — never baked into the image. This tool is for **your own** research use.
- ⚠️ **Read-write + shell workspace** lets the agent modify mounted files and run shell commands *inside
  the container*, which holds your `CLAUDE_CODE_OAUTH_TOKEN` in its environment. Only enable it on
  folders/inputs you trust — a malicious local file could attempt prompt injection. Read-only mode and
  uploads grant no shell and no writes.
- On **Linux hosts** the container runs as uid 1000 (`node`); for read-write workspace, make sure the
  mounted folder is writable by that uid. On Windows/macOS Docker Desktop this isn't an issue.

---

## Project layout

```
src/
  server.ts    HTTP + SSE + static serving; multipart uploads; fire-and-forget runs with event replay;
               report/artifact download endpoints
  pipeline.ts  the orchestrator: plan → research → evaluate → fact-check → synthesize, plus the
               feedback/refine path that re-reads a prior report
  agents.ts    headless query() wrapper — one model + focused prompt + capability-scoped tools per call
  config.ts    env parsing + auth-mode detection
  auth.ts      single-shared-secret middleware (Bearer / x-app-token / ?token=)
  store.ts     filesystem persistence, per-run dirs (uploads/outputs), workspace detection, dir listing
  util.ts      bounded-concurrency map, JSON extraction, ids
public/        single-page UI (index.html + app.js) — no build step, no CDN
Dockerfile · docker-compose.yml · .env.example
```

### HTTP endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness (no auth) |
| `GET` | `/api/config` | Models, limits, workspace availability |
| `GET` | `/api/runs` | Recent run summaries |
| `POST` | `/research` | Start a run (multipart: `goal`, `useWeb`, `workspace`, `parentId`, `feedback`, files) |
| `GET` | `/research/:id` | Full run record |
| `GET` | `/research/:id/stream` | SSE progress stream |
| `GET` | `/research/:id/report.md` · `.json` | Download the report |
| `GET` | `/research/:id/files` · `/files/:name` | List / download generated artifacts |

---

## Status & limitations

- Verified: TypeScript compiles, the Docker image builds, the server boots, auth gating works, routes
  respond, and the mounted workspace is detected. A **real research run** (agents actually searching the
  web, reading your files, running shell, writing artifacts, and refining reports) requires your Claude
  token — that first run with a token is the true end-to-end test.
- Single-user by design; one shared secret, not multi-tenant auth.
- Not hardened for direct exposure to the public internet — run it somewhere you trust.
- A few SDK field reads (cost/usage, tool names) follow the current Agent SDK; if a future SDK version
  renames them the worst case is a blank cost badge or quieter activity log — a small fix in `agents.ts`.
