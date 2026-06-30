# Research Assistant

A self-hosted, **model-tiered** deep-research assistant built on the **Claude Agent SDK**
(headless Claude — the same engine as `claude -p`). It exists to make multi-agent research
far cheaper than running everything on Opus:

| Stage | Model | Why |
| --- | --- | --- |
| **Plan** | Opus | Decompose the goal into research angles (small token share, high value) |
| **Research** (fan-out, parallel) | Sonnet | The token-heavy bulk: web search + per-subtopic synthesis |
| **Evaluate** | Opus | Coverage check, optional follow-up round, extract checkable claims |
| **Fact-check** (parallel) | Sonnet | Verify key claims against independent sources |
| **Synthesize** | Opus | Write the final cited report |

The expensive bulk runs on cheaper models; Opus is used only where it matters. Combined with
**subscription billing**, a run costs a fraction of an all-Opus "deep research."

```
goal ─► Plan(Opus) ─► Research × N (Sonnet, parallel) ─► Evaluate(Opus)
                                   ▲                          │ gaps?
                                   └──────── round 2 ◄────────┘
                          ─► Fact-check × M (Sonnet, parallel) ─► Synthesize(Opus) ─► report
```

Progress streams live to a simple web UI over SSE; reports are saved to disk.

---

## Sources & outputs

Each run chooses its sources in the UI (you can combine them):

- **Web** (default) — `WebSearch` / `WebFetch`.
- **Workspace** — a host/WSL folder mounted at `/workspace`, in one of two modes:
  - **read-only** — agents `Read`/`Grep`/`Glob` it as a source corpus.
  - **read-write + shell** — agents may also `Write`/`Edit` files and run `Bash` in it (e.g. process data, generate outputs). ⚠️ see [Security notes](#security-notes).
- **Uploads** — attach files to a single run; they land in that run's read-only `uploads/` dir.

Point the workspace at any folder with `WORKSPACE_DIR` in `.env`.

**Outputs** — every run's report is downloadable as `.md` / `.json` from the UI. In read-write mode,
files the agents save to the run's `outputs/` directory show up as downloadable artifacts.

**Follow-ups & feedback** — under any finished report there's a *Refine / follow up* box. Submitting
feedback (e.g. "go deeper on pricing" or "recheck the claim about X") spawns a linked run that
**re-reads the prior report and its findings**, does any targeted extra research, and writes a revised
report. Linked runs are marked with `↳` in Recent runs. Past runs are always re-openable from there.

---

## Prerequisites

- **Docker** (with Compose).
- A **Claude Pro / Max / Team / Enterprise** subscription (the default auth path), **or** an
  Anthropic API key (pay-per-token alternative).
- To mint a subscription token you need the Claude Code CLI once, on any machine with a browser.

---

## 1. Generate a subscription token (one time)

On a machine with a browser:

```bash
npm install -g @anthropic-ai/claude-code   # if you don't already have it
claude setup-token                         # walks through OAuth, prints a one-year token
```

Copy the printed token. It authenticates with your subscription and is scoped to inference only.
(Official docs: <https://code.claude.com/docs/en/authentication> → "Generate a long-lived token".)

> **Using an API key instead?** Skip this step; put `ANTHROPIC_API_KEY=...` in `.env` and leave
> `CLAUDE_CODE_OAUTH_TOKEN` blank. Do not set both — an API key takes precedence and switches
> billing back to pay-per-token.

---

## 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:

- `CLAUDE_CODE_OAUTH_TOKEN=` — paste the token from step 1.
- `APP_TOKEN=` — set a long random string. This is the password for the web UI. **The server
  refuses to start if it's empty.**
- Tune `FANOUT_WIDTH`, `MAX_ROUNDS`, `WORKER_CONCURRENCY`, and the per-stage `*_MODEL` vars as you like.

---

## 3. Run

```bash
docker compose up --build
```

Open <http://localhost:8787>, sign in with your `APP_TOKEN`, type a goal, and watch the agents work.

Reports persist in the `ra-data` Docker volume (`/app/data/runs/<id>.json` and `.md`).

---

## Local development (without Docker)

Requires Node ≥ 20.

```bash
npm install
# put CLAUDE_CODE_OAUTH_TOKEN + APP_TOKEN in your shell env (or a .env you load yourself)
npm run dev        # tsx watch
# or:
npm run build && npm start
```

`npm run typecheck` runs the TypeScript compiler with no emit.

---

## Configuration reference (`.env`)

| Var | Default | Meaning |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Subscription token from `claude setup-token` |
| `ANTHROPIC_API_KEY` | — | Alternative pay-per-token auth (leave blank if using the token) |
| `APP_TOKEN` | — | Shared secret for the web UI (**required**) |
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

---

## Cost & usage notes

- **Subscription auth** means runs draw from your plan's usage limits, not pay-per-token credits.
  `WORKER_CONCURRENCY` and `MAX_ROUNDS` bound how hard a single run hits the 5-hour rolling limit.
- The UI shows an **estimated** equivalent USD cost (the SDK estimates it from token usage even on a
  subscription) plus running token counts.
- Model tiering does the heavy lifting: workers on Sonnet/Haiku instead of Opus.

---

## Security notes

- The whole app is gated by `APP_TOKEN`; the server won't start without one. Use a long random value.
- Browser `EventSource` can't send headers, so the SSE stream passes the token as a `?token=` query
  param. Keep the app on a trusted network (or behind a reverse proxy / VPN) — it isn't hardened for
  the public internet.
- The OAuth token is your personal subscription credential. It lives only in `.env` (gitignored) and
  the container env — it is never baked into the image. This tool is for **your own** research use.
- ⚠️ **Read-write + shell workspace** lets the agent modify mounted files and run shell commands
  *inside the container*, which holds your `CLAUDE_CODE_OAUTH_TOKEN` in its environment. Only enable it
  on folders and inputs you trust — a malicious local file could attempt prompt injection. Read-only
  mode and uploads grant no shell and no writes.
- On **Linux hosts** the container runs as uid 1000 (`node`); for read-write workspace, make sure the
  mounted folder is writable by that uid. On Windows/macOS Docker Desktop this isn't an issue.

---

## How it's wired

```
src/
  server.ts    HTTP + SSE + static serving; fire-and-forget runs with event replay
  pipeline.ts  the 5-stage orchestrator (plan → research → evaluate → fact-check → synthesize)
  agents.ts    headless query() wrapper — one model + focused prompt + optional web tools per call
  config.ts    env parsing
  auth.ts      single-shared-secret middleware
  store.ts     filesystem persistence (data/runs/*.json + *.md)
  util.ts      bounded-concurrency map, JSON extraction, ids
public/        single-page UI (index.html + app.js, no build step, no CDN)
```
