import type { Ticket } from "../../../server/features/jira/issues.ts";

export type TicketRow = Omit<Ticket, "descriptionAdf" | "descriptionMd" | "acceptanceCriteria">;

// The team's Jira workflow order. Statuses outside it stay visible under their real name, after these.
export const WORKFLOW = ["QUÉ", "En curso", "In Product Review", "Release Ready"] as const;

export type Group<T> = { status: string; known: boolean; tickets: T[] };

export function groupByStatus<T extends Pick<Ticket, "status">>(tickets: T[]): Group<T>[] {
  const byStatus = new Map<string, T[]>();
  for (const t of tickets) {
    const list = byStatus.get(t.status.name) ?? [];
    list.push(t);
    byStatus.set(t.status.name, list);
  }
  const known = WORKFLOW.filter((s) => byStatus.has(s)).map((status) => ({
    status,
    known: true,
    tickets: byStatus.get(status) ?? [],
  }));
  const others = [...byStatus.keys()]
    .filter((s) => !(WORKFLOW as readonly string[]).includes(s))
    .sort((a, b) => a.localeCompare(b, "es"))
    .map((status) => ({ status, known: false, tickets: byStatus.get(status) ?? [] }));
  return [...known, ...others];
}

// 0..1 position in the workflow, used for the progress-pie status icon.
export function workflowProgress(status: string, category: string): number {
  if (category === "done") return 1;
  const i = (WORKFLOW as readonly string[]).indexOf(status);
  if (i === -1) return category === "indeterminate" ? 0.5 : 0;
  return i / WORKFLOW.length;
}
