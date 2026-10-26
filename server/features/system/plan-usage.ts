import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// A subscription's limit windows (Claude: 5 h and the week; Codex: what its plan has), each in
// percent with when it renews, and when the harness last wrote them.
export type LimitWindow = { minutes: number; percent: number | null; resetAt: string | null };
export type PlanUsage =
  | { windows: LimitWindow[]; updatedAt: string }
  | { error: "no_source" | "bad_data" };

// Claude: the current 5-hour session and the week. Poneglyph's hud mod writes them from the
// rate limits each response reports; ccstatusline caches them after asking Anthropic's usage
// API. Both use one shape and need no credentials; the file written last wins.
export const PLAN_USAGE_FILES = [
  join(homedir(), ".cache", "poneglyph", "usage.json"),
  join(homedir(), ".cache", "ccstatusline", "usage.json"),
];

const Cached = z.object({
  sessionUsage: z.number().nullable().optional(),
  sessionResetAt: z.string().nullable().optional(),
  weeklyUsage: z.number().nullable().optional(),
  weeklyResetAt: z.string().nullable().optional(),
});

export async function readPlanUsage(files = PLAN_USAGE_FILES): Promise<PlanUsage> {
  const read = await Promise.all(files.map(readUsageFile));
  const fresh = read
    .filter((r) => "windows" in r)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return (
    fresh ?? read.find((r) => "error" in r && r.error === "bad_data") ?? { error: "no_source" }
  );
}

async function readUsageFile(file: string): Promise<PlanUsage> {
  let text: string;
  let mtime: Date;
  try {
    [text, mtime] = await Promise.all([readFile(file, "utf8"), stat(file).then((s) => s.mtime)]);
  } catch {
    return { error: "no_source" };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { error: "bad_data" };
  }
  const parsed = Cached.safeParse(json);
  if (!parsed.success) return { error: "bad_data" };
  const d = parsed.data;
  if (d.sessionUsage == null && d.weeklyUsage == null) return { error: "bad_data" };
  return {
    windows: [
      { minutes: 300, percent: d.sessionUsage ?? null, resetAt: d.sessionResetAt ?? null },
      { minutes: 10_080, percent: d.weeklyUsage ?? null, resetAt: d.weeklyResetAt ?? null },
    ],
    updatedAt: mtime.toISOString(),
  };
}

// Codex: each rollout's token_count events carry the plan's rate limits, as Codex got them
// from its API. The newest reading is in the rollout written last. A session writes into the
// directory of the day it started, so a few days back are searched.
export const CODEX_SESSIONS = join(homedir(), ".codex", "sessions");
const CODEX_DAYS = 3;
const CODEX_FILES = 5;
// The poll runs every few seconds and a rollout grows to megabytes: only its end is read.
const TAIL_BYTES = 256 * 1024;

const CodexWindow = z.object({
  used_percent: z.number(),
  window_minutes: z.number().int().positive(),
  resets_at: z.number(),
});
const CodexLine = z.looseObject({
  timestamp: z.iso.datetime(),
  payload: z.looseObject({
    type: z.literal("token_count"),
    rate_limits: z.looseObject({
      primary: CodexWindow.nullish(),
      secondary: CodexWindow.nullish(),
    }),
  }),
});

const listDesc = async (dir: string) => {
  try {
    return (await readdir(dir)).sort().reverse();
  } catch {
    return [];
  }
};

// The newest rollouts by modification time, from the last few day directories.
async function recentRollouts(root: string): Promise<string[]> {
  const days: string[] = [];
  for (const y of await listDesc(root))
    for (const m of await listDesc(join(root, y)))
      for (const d of await listDesc(join(root, y, m))) {
        if (days.length === CODEX_DAYS) break;
        days.push(join(root, y, m, d));
      }
  const files: { path: string; mtime: number }[] = [];
  for (const day of days)
    for (const name of await listDesc(day)) {
      if (!/^rollout-.*\.jsonl$/.test(name)) continue;
      const path = join(day, name);
      const s = await stat(path).catch(() => undefined);
      if (s) files.push({ path, mtime: s.mtimeMs });
    }
  return files
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, CODEX_FILES)
    .map((f) => f.path);
}

async function tail(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    await file.read(buf, 0, length, size - length);
    return buf.toString("utf8");
  } finally {
    await file.close();
  }
}

// The last rate-limit reading in a rollout's end, or undefined when it has none.
function lastLimits(text: string): PlanUsage | undefined {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    if (!line.includes('"rate_limits":{')) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = CodexLine.safeParse(json);
    if (!parsed.success) return { error: "bad_data" };
    const { primary, secondary } = parsed.data.payload.rate_limits;
    const windows = [primary, secondary].flatMap((w) =>
      w
        ? [
            {
              minutes: w.window_minutes,
              percent: w.used_percent,
              resetAt: new Date(w.resets_at * 1000).toISOString(),
            },
          ]
        : [],
    );
    if (windows.length === 0) return { error: "bad_data" };
    // Shortest window first, as Claude's 5 h comes before its week.
    windows.sort((a, b) => a.minutes - b.minutes);
    return { windows, updatedAt: new Date(parsed.data.timestamp).toISOString() };
  }
  return undefined;
}

export async function readCodexUsage(root = CODEX_SESSIONS): Promise<PlanUsage> {
  for (const path of await recentRollouts(root)) {
    const found = lastLimits(await tail(path).catch(() => ""));
    if (found) return found;
  }
  return { error: "no_source" };
}
