// Thin wrapper around the Claude Agent SDK's headless `query()`.
//
// Each call here is one "agent": a single model, a focused system prompt, and
// an optional read-only web toolset. The pipeline composes these into stages.
//
// Auth is implicit: the SDK reads CLAUDE_CODE_OAUTH_TOKEN (subscription) or
// ANTHROPIC_API_KEY from the environment. We never pass credentials here.

import { query } from "@anthropic-ai/claude-agent-sdk";

// Built-in Claude Code tool names, grouped by capability. We assemble each
// stage's allowedTools from these based on the run's sources.
export const WEB_TOOLS = ["WebSearch", "WebFetch"] as const;
export const READ_TOOLS = ["Read", "Grep", "Glob"] as const; // read local files
export const WRITE_TOOLS = ["Write", "Edit", "Bash"] as const; // mutate + run shell
export const NO_TOOLS: string[] = [];

export interface AgentUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface AgentResult {
  text: string;
  ok: boolean;
  subtype: string;
  usage: AgentUsage;
  costUsd: number;
  model: string;
}

export interface ToolActivity {
  tool: string;
  detail: string;
}

export interface RunAgentOptions {
  model: string;
  systemPrompt: string;
  prompt: string;
  allowedTools?: string[];
  maxTurns?: number;
  /** Working directory for filesystem/bash tools (workspace or uploads dir). */
  cwd?: string;
  /** Called whenever the agent invokes a tool — used for live progress. */
  onActivity?: (a: ToolActivity) => void;
}

// Minimal structural views of the SDK message union (kept local so we don't
// depend on exact exported type names across SDK versions).
interface AssistantMessageView {
  type: "assistant";
  message?: {
    content?: Array<{
      type: string;
      name?: string;
      text?: string;
      input?: Record<string, unknown>;
    }>;
  };
}
interface ResultMessageView {
  type: "result";
  subtype?: string;
  result?: string;
  total_cost_usd?: number;
  usage?: AgentUsage;
}

function summarizeToolInput(name: string | undefined, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  if (name === "WebSearch" && typeof obj.query === "string") return obj.query;
  if (name === "WebFetch" && typeof obj.url === "string") return String(obj.url);
  const firstString = Object.values(obj).find((v) => typeof v === "string");
  return typeof firstString === "string" ? firstString.slice(0, 120) : "";
}

export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
  const iterator = query({
    prompt: opts.prompt,
    options: {
      model: opts.model,
      systemPrompt: opts.systemPrompt,
      allowedTools: opts.allowedTools ?? NO_TOOLS,
      // Headless: never block waiting for an interactive approval. We constrain
      // capability through allowedTools + focused prompts instead. Requires the
      // process to run as a non-root user (see Dockerfile).
      permissionMode: "bypassPermissions",
      // Do not inherit ~/.claude or project settings/agents/MCP — keep each run
      // hermetic and reproducible inside the container.
      settingSources: [],
      maxTurns: opts.maxTurns ?? 6,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    },
  });

  let text = "";
  let subtype = "success";
  let usage: AgentUsage = {};
  let costUsd = 0;

  try {
    for await (const message of iterator) {
      const type = (message as { type?: string }).type;
      if (type === "assistant") {
        const am = message as unknown as AssistantMessageView;
        for (const block of am.message?.content ?? []) {
          if (block.type === "tool_use") {
            opts.onActivity?.({
              tool: block.name ?? "tool",
              detail: summarizeToolInput(block.name, block.input),
            });
          }
        }
      } else if (type === "result") {
        const rm = message as unknown as ResultMessageView;
        subtype = rm.subtype ?? "success";
        if (typeof rm.result === "string") text = rm.result;
        usage = rm.usage ?? {};
        costUsd = typeof rm.total_cost_usd === "number" ? rm.total_cost_usd : 0;
      }
    }
  } catch (err) {
    // The SDK throws when maxTurns is exhausted rather than emitting a result.
    // Treat this as a soft max_turns result so the pipeline can continue with
    // whatever partial text was accumulated before the limit was hit.
    const msg = err instanceof Error ? err.message : String(err);
    if (/max.{0,30}turn|turn.{0,30}max/i.test(msg)) {
      subtype = "max_turns";
    } else {
      throw err;
    }
  }

  return {
    text,
    ok: subtype === "success",
    subtype,
    usage,
    costUsd,
    model: opts.model,
  };
}

export function addUsage(a: AgentUsage, b: AgentUsage): AgentUsage {
  return {
    input_tokens: (a.input_tokens ?? 0) + (b.input_tokens ?? 0),
    output_tokens: (a.output_tokens ?? 0) + (b.output_tokens ?? 0),
    cache_creation_input_tokens:
      (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens:
      (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
  };
}
