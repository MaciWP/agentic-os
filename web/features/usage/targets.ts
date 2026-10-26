// What each controlled figure should be, so a figure reads as on target, to watch or off.
// Agreed with Oriol on 2026-10-16, Log Pose's turns and judge on 2026-10-22; shares are 0-1.
// ponytail: constants in code, move to data/config.json when he wants to tune them himself.

export type Target = { ok: number; warn: number; better: "up" | "down"; text: string };
export type Verdict = "ok" | "warn" | "bad";

export const TARGETS = {
  // Router and Log Pose.
  accepted: { ok: 0.4, warn: 0.25, better: "up", text: "≥ 40 %" },
  missed: { ok: 0.2, warn: 0.35, better: "down", text: "≤ 20 %" },
  delivered: { ok: 0.95, warn: 0.85, better: "up", text: "≥ 95 %" },
  failed: { ok: 0.02, warn: 0.05, better: "down", text: "≤ 2 %" },
  overrides: { ok: 0.15, warn: 0.25, better: "down", text: "≤ 15 %" },
  gaugeFollowed: { ok: 0.7, warn: 0.5, better: "up", text: "≥ 70 %" },
  // The weekly judge's verdicts.
  effortFit: { ok: 0.8, warn: 0.65, better: "up", text: "≥ 80 %" },
  gaugeFit: { ok: 0.75, warn: 0.6, better: "up", text: "≥ 75 %" },
  fixesRight: { ok: 0.9, warn: 0.8, better: "up", text: "≥ 90 %" },
  cacheBreaks: { ok: 0, warn: 1, better: "down", text: "0" },
  // Spend and health.
  advisorShare: { ok: 0.1, warn: 0.15, better: "down", text: "≤ 10 %" },
  hookFailures: { ok: 0, warn: 1, better: "down", text: "0" },
  coverage: { ok: 0.95, warn: 0.9, better: "up", text: "≥ 95 %" },
} satisfies Record<string, Target>;

export function verdictOf(value: number, t: Target): Verdict {
  if (t.better === "up") return value >= t.ok ? "ok" : value >= t.warn ? "warn" : "bad";
  return value <= t.ok ? "ok" : value <= t.warn ? "warn" : "bad";
}
