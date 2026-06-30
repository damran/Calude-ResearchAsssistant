// Filesystem persistence and per-run working directories.
//
//   data/runs/<id>.json     full run record
//   data/runs/<id>.md       convenience copy of the report
//   data/runs/<id>/uploads/ files the user uploaded for this run (read-only inputs)
//   data/runs/<id>/outputs/ files agents generated for this run (downloadable)

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { RunRecord } from "./pipeline.js";

const DATA_DIR = (process.env.DATA_DIR ?? "").trim() || path.resolve("data");
const RUNS_DIR = path.join(DATA_DIR, "runs");

// The mounted workspace inside the container (a bind mount from the host/WSL).
export const WORKSPACE_PATH = (process.env.WORKSPACE_PATH ?? "").trim() || "/workspace";

export function workspaceAvailable(): boolean {
  try {
    return existsSync(WORKSPACE_PATH) && statSync(WORKSPACE_PATH).isDirectory();
  } catch {
    return false;
  }
}

const idOk = (id: string) => /^[a-z0-9]+$/i.test(id);

export const runDir = (id: string) => path.join(RUNS_DIR, id);
export const uploadsDir = (id: string) => path.join(RUNS_DIR, id, "uploads");
export const outputsDir = (id: string) => path.join(RUNS_DIR, id, "outputs");

export async function ensureStore(): Promise<void> {
  await mkdir(RUNS_DIR, { recursive: true });
}

export async function ensureRunDirs(id: string): Promise<void> {
  await mkdir(uploadsDir(id), { recursive: true });
  await mkdir(outputsDir(id), { recursive: true });
}

/** Sanitize a user/agent-supplied file name to a single safe path segment. */
export function safeName(name: string): string | null {
  const base = path.basename(name).replace(/[^A-Za-z0-9._ -]/g, "_").trim();
  if (!base || base === "." || base === "..") return null;
  return base.slice(0, 200);
}

export interface FileEntry {
  name: string;
  size: number;
}

export async function listOutputs(id: string): Promise<FileEntry[]> {
  if (!idOk(id)) return [];
  const dir = outputsDir(id);
  try {
    const names = await readdir(dir);
    const entries = await Promise.all(
      names.map(async (n) => {
        try {
          const s = await stat(path.join(dir, n));
          return s.isFile() ? { name: n, size: s.size } : null;
        } catch {
          return null;
        }
      }),
    );
    return entries.filter((e): e is FileEntry => e !== null);
  } catch {
    return [];
  }
}

export async function listUploads(id: string): Promise<string[]> {
  if (!idOk(id)) return [];
  try {
    return await readdir(uploadsDir(id));
  } catch {
    return [];
  }
}

/** Absolute path to an output file, or null if the name is unsafe/missing. */
export function outputPath(id: string, name: string): string | null {
  if (!idOk(id)) return null;
  const safe = safeName(name);
  if (!safe) return null;
  return path.join(outputsDir(id), safe);
}

/** A depth-limited directory listing, for handing local context to the planner. */
export async function dirTree(root: string, maxDepth = 2, maxEntries = 200): Promise<string> {
  const lines: string[] = [];
  let count = 0;
  async function walk(dir: string, depth: number, prefix: string): Promise<void> {
    if (depth > maxDepth || count >= maxEntries) return;
    let names: string[];
    try {
      names = (await readdir(dir)).sort();
    } catch {
      return;
    }
    for (const n of names) {
      if (count >= maxEntries) {
        lines.push(`${prefix}… (truncated)`);
        return;
      }
      if (n === "node_modules" || n === ".git") continue;
      const full = path.join(dir, n);
      let isDir = false;
      try {
        isDir = (await stat(full)).isDirectory();
      } catch {
        continue;
      }
      count++;
      lines.push(`${prefix}${n}${isDir ? "/" : ""}`);
      if (isDir) await walk(full, depth + 1, prefix + "  ");
    }
  }
  await walk(root, 1, "");
  return lines.length ? lines.join("\n") : "(empty)";
}

export interface RunSummary {
  id: string;
  goal: string;
  status: RunRecord["status"];
  createdAt: string;
  finishedAt?: string;
  costUsd: number;
  parentId?: string;
}

export async function saveRecord(record: RunRecord): Promise<void> {
  await ensureStore();
  await writeFile(path.join(RUNS_DIR, `${record.id}.json`), JSON.stringify(record, null, 2), "utf8");
  if (record.reportMarkdown) {
    const header = `# ${record.goal}\n\n_Run ${record.id} · ${record.status} · est. $${record.costUsd.toFixed(4)}_\n\n---\n\n`;
    await writeFile(path.join(RUNS_DIR, `${record.id}.md`), header + record.reportMarkdown, "utf8");
  }
}

export async function loadRecord(id: string): Promise<RunRecord | null> {
  if (!idOk(id)) return null;
  try {
    const raw = await readFile(path.join(RUNS_DIR, `${id}.json`), "utf8");
    return JSON.parse(raw) as RunRecord;
  } catch {
    return null;
  }
}

export async function listSummaries(limit = 50): Promise<RunSummary[]> {
  await ensureStore();
  let files: string[];
  try {
    files = (await readdir(RUNS_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const records = await Promise.all(
    files.map(async (f) => {
      try {
        const r = JSON.parse(await readFile(path.join(RUNS_DIR, f), "utf8")) as RunRecord;
        const summary: RunSummary = {
          id: r.id,
          goal: r.goal,
          status: r.status,
          createdAt: r.createdAt,
          finishedAt: r.finishedAt,
          costUsd: r.costUsd ?? 0,
          parentId: r.parentId,
        };
        return summary;
      } catch {
        return null;
      }
    }),
  );
  return records
    .filter((r): r is RunSummary => r !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

export { DATA_DIR };
