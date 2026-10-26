import type { ReactNode } from "react";
import { pct } from "./charts.tsx";
import type { Col } from "./kit.tsx";
import type { UsageLine, UsageReport } from "./queries.ts";

type Count = { name: string; detail: string; count: number };
export const countCols = (head: string): Col<Count>[] => [
  { head, cell: (c) => <span className="font-mono">{c.name}</span> },
  { head: "Veces", num: true, cell: (c) => c.count },
];

// A skill's loads (the Skill tool) next to the tokens spent while Claude attributed calls to it.
export function skillRows(r: UsageReport) {
  const loads = new Map<string, number>();
  for (const s of r.events.skills) loads.set(s.name, (loads.get(s.name) ?? 0) + s.count);
  const lines = new Map(r.bySkill.map((l) => [l.key, l]));
  const names = [...new Set([...lines.keys(), ...loads.keys()])];
  return names.map((name) => ({ name, loads: loads.get(name) ?? 0, line: lines.get(name) }));
}

// Subagents by type: how often each was started, with which model asked, and what they spent.
export function subagentRows(r: UsageReport) {
  const started = new Map<string, { count: number; models: Map<string, number> }>();
  for (const s of r.events.subagents) {
    const row = started.get(s.name) ?? { count: 0, models: new Map() };
    row.count += s.count;
    const model = s.detail || "hereda";
    row.models.set(model, (row.models.get(model) ?? 0) + s.count);
    started.set(s.name, row);
  }
  const lines = new Map(r.bySubagent.map((l) => [l.key, l]));
  const names = [...new Set([...lines.keys(), ...started.keys()])];
  return names.map((name) => {
    const s = started.get(name);
    const models = s ? [...s.models].map(([m, n]) => `${m} ×${n}`).join(", ") : "—";
    return { name, count: s?.count ?? 0, models, line: lines.get(name) };
  });
}

export const ROLE_NAMES: Record<string, string> = {
  lead: "Sesión principal",
  subagent: "Subagentes",
  advisor: "Advisor",
};

// Calls whose prompt went over 100K tokens: Haiku 5.5 bills them at five times the price.
export const longText = (l: UsageLine) =>
  l.calls ? `${l.longCalls} (${pct(l.longCalls / l.calls)})` : "—";
export const LONG_HEAD = "Más de 100K";

export const optionalLine = (pick: (l: UsageLine) => ReactNode) => (row: { line?: UsageLine }) =>
  row.line ? pick(row.line) : <span className="text-ink-2">—</span>;
