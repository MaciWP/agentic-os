import type { LimitWindow, Plans, PlanUsage, SystemSnapshot } from "./queries.ts";

// Past this a harness has not refreshed its subscription's use in a while.
export const PLAN_STALE_MS = 15 * 60_000;

export type Usage = { cpu: number; rssKb: number };
export type Agent = keyof Plans;

export const AGENTS: { id: Agent; name: string }[] = [
  { id: "claude", name: "Claude" },
  { id: "codex", name: "Codex" },
  { id: "grok", name: "Grok" },
];

// The app and its running terminals together; a process ps did not find adds nothing.
export function totals(s: SystemSnapshot): Usage {
  const all = [s.app.server, s.app.host, ...s.terminals];
  return all.reduce<Usage>(
    (sum, u) => ({ cpu: sum.cpu + (u?.cpu ?? 0), rssKb: sum.rssKb + (u?.rssKb ?? 0) }),
    { cpu: 0, rssKb: 0 },
  );
}

export const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n)} %`);
export const dayTime = new Intl.DateTimeFormat("es-ES", {
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});
export const resetAt = (iso: string | null, f: (iso: string) => string) =>
  iso && !Number.isNaN(Date.parse(iso)) ? f(iso) : null;

// A limit window by its length, as the harness reports it: Claude's 5 h and week, Codex's own.
export function windowName(minutes: number): string {
  if (minutes === 300) return "Sesión (5 h)";
  if (minutes === 10_080) return "Semana";
  if (minutes % 1440 === 0) return `${minutes / 1440} d`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

// A reading taken before its window renewed says nothing about the new window: no number.
export const renewed = (iso: string | null, now: number) => iso !== null && now >= Date.parse(iso);
const limitText = (w: LimitWindow, now: number) =>
  renewed(w.resetAt, now) ? "renovada" : pct(w.percent);

export const planStale = (plan: PlanUsage, now: number) =>
  !("error" in plan) && now - Date.parse(plan.updatedAt) > PLAN_STALE_MS;

export const planText = (plan: PlanUsage, now: number) =>
  "error" in plan ? "sin dato" : plan.windows.map((w) => limitText(w, now)).join(" · ");

// The line has room for one number per harness: its window nearest the limit. A window that
// renewed since the reading says nothing, so it is left out.
export function peakText(plan: PlanUsage, now: number): string | null {
  if ("error" in plan) return null;
  const live = plan.windows.flatMap((w) =>
    renewed(w.resetAt, now) || w.percent === null ? [] : [w.percent],
  );
  return live.length === 0 ? "—" : `${Math.round(Math.max(...live))}%`;
}
