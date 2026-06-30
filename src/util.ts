// Small dependency-free helpers shared across the pipeline.

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Run `fn` over `items` with at most `limit` promises in flight at once.
 * Results preserve input order. Used to bound how many worker agents run
 * concurrently (which bounds subscription burst usage).
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const width = clamp(limit, 1, Math.max(1, items.length));
  const workers = Array.from({ length: width }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx] as T, idx);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Best-effort extraction of a JSON value from model output. Handles raw JSON,
 * ```json fenced blocks, and JSON embedded in prose by scanning for the first
 * balanced object/array (string- and escape-aware).
 */
export function extractJson<T = unknown>(text: string): T | null {
  if (!text) return null;
  const tryParse = (s: string): T | null => {
    try {
      return JSON.parse(s) as T;
    } catch {
      return null;
    }
  };

  const direct = tryParse(text.trim());
  if (direct !== null) return direct;

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) {
    const parsed = tryParse(fence[1].trim());
    if (parsed !== null) return parsed;
  }

  const start = text.search(/[[{]/);
  if (start === -1) return null;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = start; j < text.length; j++) {
    const ch = text[j] as string;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return tryParse(text.slice(start, j + 1));
    }
  }
  return null;
}

export function newId(): string {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  ).toLowerCase();
}
