// Centralised environment configuration. Parsed once at startup.

function str(name: string, def: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : def;
}

function int(name: string, def: number): number {
  const v = process.env[name];
  const n = v ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) ? n : def;
}

export const config = {
  host: str("HOST", "0.0.0.0"),
  port: int("PORT", 8787),

  // App access control — a single shared secret. Empty means "refuse to start".
  appToken: (process.env.APP_TOKEN ?? "").trim(),

  // Per-stage model selection (aliases track latest; full ids also accepted).
  models: {
    plan: str("PLAN_MODEL", "opus"),
    research: str("RESEARCH_MODEL", "sonnet"),
    evaluate: str("EVAL_MODEL", "opus"),
    factcheck: str("FACTCHECK_MODEL", "sonnet"),
    synth: str("SYNTH_MODEL", "opus"),
  },

  fanoutWidth: int("FANOUT_WIDTH", 4),
  maxRounds: int("MAX_ROUNDS", 2),
  workerConcurrency: int("WORKER_CONCURRENCY", 4),
  researchMaxTurns: int("RESEARCH_MAX_TURNS", 8),
  factcheckMaxTurns: int("FACTCHECK_MAX_TURNS", 6),
} as const;

// True when authenticated to Claude via subscription OAuth (no API key set).
export function authMode(): "subscription" | "api-key" | "none" {
  if ((process.env.ANTHROPIC_API_KEY ?? "").trim()) return "api-key";
  if ((process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim()) return "subscription";
  return "none";
}
