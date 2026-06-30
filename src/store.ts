// Filesystem persistence — one JSON record (+ a convenience .md) per run under
// data/runs/. No database; the directory is a Docker volume.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunRecord } from "./pipeline.js";

const DATA_DIR = (process.env.DATA_DIR ?? "").trim() || path.resolve("data");
const RUNS_DIR = path.join(DATA_DIR, "runs");

export interface RunSummary {
  id: string;
  goal: string;
  status: RunRecord["status"];
  createdAt: string;
  finishedAt?: string;
  costUsd: number;
}

export async function ensureStore(): Promise<void> {
  await mkdir(RUNS_DIR, { recursive: true });
}

export async function saveRecord(record: RunRecord): Promise<void> {
  await ensureStore();
  const jsonPath = path.join(RUNS_DIR, `${record.id}.json`);
  await writeFile(jsonPath, JSON.stringify(record, null, 2), "utf8");
  if (record.reportMarkdown) {
    const mdPath = path.join(RUNS_DIR, `${record.id}.md`);
    const header = `# ${record.goal}\n\n_Run ${record.id} · ${record.status} · est. $${record.costUsd.toFixed(4)}_\n\n---\n\n`;
    await writeFile(mdPath, header + record.reportMarkdown, "utf8");
  }
}

export async function loadRecord(id: string): Promise<RunRecord | null> {
  if (!/^[a-z0-9]+$/i.test(id)) return null; // guard against path traversal
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
        const raw = await readFile(path.join(RUNS_DIR, f), "utf8");
        const r = JSON.parse(raw) as RunRecord;
        const summary: RunSummary = {
          id: r.id,
          goal: r.goal,
          status: r.status,
          createdAt: r.createdAt,
          finishedAt: r.finishedAt,
          costUsd: r.costUsd ?? 0,
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
