import { keyIn } from "../../../shared/envs.ts";
import type { TicketRow } from "../tickets/groups.ts";
import type { Inbox, InboxItem, NeedItem, Urgency } from "./inbox.ts";

// Which of the user's tickets each inbox item works on, so a ticket can show its agents and
// its PR together. Only keys of tickets the user has count: a stray "AB-1" in a title links
// nothing.

// How the link was made, so the screen can say when it is a guess.
export type Link = "field" | "path" | "title";

export { keyIn };

export function ticketOf(
  item: InboxItem,
  keys: readonly string[],
): { key: string; link: Link } | null {
  const found = (key: string | null, link: Link) => (key ? { key, link } : null);
  switch (item.kind) {
    case "ticket":
      return { key: item.ticket.key, link: "field" };
    case "agent":
      // The app records the ticket an agent was launched for; a worktree path names the rest.
      return (
        found(item.t.ticket && keys.includes(item.t.ticket) ? item.t.ticket : null, "field") ??
        found(keyIn(item.t.cwd, keys), "path")
      );
    case "outside":
      return found(keyIn(item.s.cwd, keys), "path") ?? found(keyIn(item.s.name, keys), "title");
    case "pr":
      // ponytail: the PR list carries no branch, so only its title links it; read the head
      // branch once the inbox list returns it (plan gap B2).
      return found(keyIn(item.pr.title, keys), "title");
  }
}

export type Linked = { item: InboxItem; urgency: Urgency | null; link: Link };

export type Work = {
  ticket: TicketRow;
  // Agents, sessions and PRs on this ticket, most urgent first.
  items: Linked[];
  // The most urgent thing it holds, or null when nothing waits on the user.
  urgency: Urgency | null;
};

const RANK: Record<Urgency, number> = { failed: 0, asks: 1, review: 2, idle: 3 };
const rank = (u: Urgency | null) => (u === null ? 4 : RANK[u]);

// A goal the user set on agents (the tile's objective chip), with those agents.
export type GoalWork = {
  goal: { id: number; title: string };
  items: Linked[];
  urgency: Urgency | null;
};

// Every ticket with what works on it, every goal with its agents, and what works on neither.
// Tickets that hold an interruption come first, then the rest in their list order.
export function byTicket(
  tickets: readonly TicketRow[],
  inbox: Inbox,
): { work: Work[]; goals: GoalWork[]; loose: Linked[] } {
  const keys = tickets.map((t) => t.key);
  const map = new Map<string, Linked[]>(keys.map((k) => [k, []]));
  const loose: Linked[] = [];
  const goals = new Map<number, GoalWork>();
  const all: (InboxItem | NeedItem)[] = [...inbox.needs, ...inbox.running, ...inbox.todo];
  for (const item of all) {
    if (item.kind === "ticket") continue;
    const urgency = "urgency" in item ? item.urgency : null;
    const on = ticketOf(item, keys);
    const linked = { item, urgency, link: on?.link ?? "field" };
    const goal = item.kind === "agent" ? item.t.objective : null;
    if (goal?.kind === "goal") {
      const g = goals.get(goal.id) ?? { goal, items: [], urgency: null };
      g.items.push({ ...linked, link: "field" });
      goals.set(goal.id, g);
    } else if (on) map.get(on.key)?.push(linked);
    else loose.push(linked);
  }
  const work = tickets.map((ticket) => {
    const items = (map.get(ticket.key) ?? []).sort((a, b) => rank(a.urgency) - rank(b.urgency));
    return { ticket, items, urgency: items[0]?.urgency ?? null };
  });
  const order = new Map(tickets.map((t, i) => [t.key, i]));
  work.sort(
    (a, b) =>
      rank(a.urgency) - rank(b.urgency) ||
      (order.get(a.ticket.key) ?? 0) - (order.get(b.ticket.key) ?? 0),
  );
  const goalWork = [...goals.values()].map((g) => {
    const items = g.items.sort((a, b) => rank(a.urgency) - rank(b.urgency));
    return {
      goal: { id: g.goal.id, title: g.goal.title },
      items,
      urgency: items[0]?.urgency ?? null,
    };
  });
  return { work, goals: goalWork, loose };
}
