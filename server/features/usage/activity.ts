import type { Database } from "bun:sqlite";

// What each agent did lately, for the strip on its card in Agentes: model calls in the last
// two hours, five minutes to a bar. An app terminal is keyed by its id, any other session by
// "harness:session". A running app terminal with a session gets its bars even when it made no
// call, so an empty strip means quiet, never unknown.

export const SLOT_MS = 5 * 60_000;
export const SLOTS = 24;

export type Activity = { to: string; slotMs: number; calls: Record<string, number[]> };

export function activityOf(db: Database, now: number): Activity {
  const from = now - SLOT_MS * SLOTS;
  const calls: Record<string, number[]> = {};
  const bars = (key: string) => {
    calls[key] ??= Array.from({ length: SLOTS }, () => 0);
    return calls[key];
  };
  const terminals = new Map<string, string>();
  for (const t of db
    .query<{ id: string; session_id: string; state: string }, []>(
      "SELECT id, session_id, state FROM terminal_sessions WHERE session_id IS NOT NULL",
    )
    .all()) {
    terminals.set(t.session_id, t.id);
    if (t.state === "running") bars(t.id);
  }
  // Every harness writes `at` in UTC ("Z" or "+00:00"), so the text sorts in time order.
  const rows = db
    .query<{ harness: string; session_id: string; at: string }, [string]>(
      "SELECT harness, session_id, at FROM agent_usage WHERE at >= ?",
    )
    .all(new Date(from).toISOString());
  for (const r of rows) {
    const slot = Math.floor((Date.parse(r.at) - from) / SLOT_MS);
    if (!(slot >= 0 && slot < SLOTS)) continue;
    const key = terminals.get(r.session_id) ?? `${r.harness}:${r.session_id}`;
    const b = bars(key);
    b[slot] = (b[slot] ?? 0) + 1;
  }
  return { to: new Date(now).toISOString(), slotMs: SLOT_MS, calls };
}
