import type { Database } from "bun:sqlite";
import { errorMessage } from "../../error-message.ts";
import { log } from "../../log.ts";
import { type PlanUsage, readCodexUsage, readPlanUsage } from "../system/plan-usage.ts";

// The plans' limit windows over time, so Consumo can draw how a quota week filled. The
// harnesses keep only their latest reading; each sample keeps one more.

export type PlanReaders = Record<"claude" | "codex", () => Promise<PlanUsage>>;
const READERS: PlanReaders = { claude: () => readPlanUsage(), codex: () => readCodexUsage() };

type Last = { percent: number | null; reset_at: string | null };

// Writes each window whose percent or reset changed since the last sample, at the time the
// harness read it; returns the rows written. A harness with no reading is skipped, and one whose
// reader throws is logged without costing the others their sample.
export async function samplePlans(db: Database, readers: PlanReaders = READERS): Promise<number> {
  const last = db.query<Last, [string, number]>(
    `SELECT percent, reset_at FROM plan_samples WHERE harness = ? AND window_minutes = ?
     ORDER BY at DESC LIMIT 1`,
  );
  const insert = db.query(
    `INSERT OR IGNORE INTO plan_samples (harness, window_minutes, at, percent, reset_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  let written = 0;
  for (const [harness, read] of Object.entries(readers)) {
    const plan = await read().catch((err: unknown) => {
      log("usage").warn(`plan sample: ${harness}`, { err: errorMessage(err) });
      return { error: "threw" } as const;
    });
    if ("error" in plan) continue;
    for (const w of plan.windows) {
      const before = last.get(harness, w.minutes);
      if (before && before.percent === w.percent && before.reset_at === w.resetAt) continue;
      written += insert.run(harness, w.minutes, plan.updatedAt, w.percent, w.resetAt).changes;
    }
  }
  return written;
}
