import type { Pr } from "../../../server/features/github/prs.ts";
import type { AgentsSnapshot } from "../../../server/features/monitor/monitor.ts";
import { agentState } from "../monitor/queries.ts";
import { STATUS } from "../sessions/panel.tsx";
import type { TerminalInfo } from "../terminals/queries.ts";
import type { TicketRow } from "../tickets/groups.ts";

export type BucketId = "needs" | "running" | "todo";

export const BUCKETS: { id: BucketId; title: string }[] = [
  { id: "needs", title: "Te necesita" },
  { id: "running", title: "En marcha" },
  { id: "todo", title: "Por empezar" },
];

type Outside = AgentsSnapshot["outside"][number];

// One thing that waits on the user or moves without them, with the word its source uses.
export type InboxItem =
  | { kind: "agent"; id: string; label: string; t: TerminalInfo }
  | { kind: "outside"; id: string; label: string; s: Outside }
  | { kind: "pr"; id: string; pr: Pr }
  | { kind: "ticket"; id: string; ticket: TicketRow };

// Within "Te necesita", what cannot wait comes first: a terminal that failed, an agent that
// asked a question, a review asked of the user, then an agent whose turn ended.
export type Urgency = "failed" | "asks" | "review" | "idle";
const RANK: Record<Urgency, number> = { failed: 0, asks: 1, review: 2, idle: 3 };

export type NeedItem = InboxItem & { urgency: Urgency };

// What interrupts: a question, a failure, a review request. A finished turn waits too, but
// quietly; the headline counts only interrupts so every screen says the same number.
export const interrupts = (i: NeedItem) => i.urgency !== "idle";
export type Inbox = { needs: NeedItem[]; running: InboxItem[]; todo: InboxItem[] };

export type InboxSources = {
  terminals?: TerminalInfo[];
  agents?: AgentsSnapshot;
  prs?: Pr[];
  tickets?: TicketRow[];
};

const AGENTS = new Set(["claude", "codex", "grok"]);

type Placed =
  | { bucket: "needs"; urgency: Urgency; label: string }
  | { bucket: "running"; label: string };

function placeTerminal(t: TerminalInfo, status: string | null | undefined): Placed | null {
  const state = agentState(t, status);
  if (state.bucket === "ended") return null;
  if (state.bucket === "failed") return { bucket: "needs", urgency: "failed", label: state.label };
  // A shell or an env command waiting at its prompt asks nothing of the user.
  if (!AGENTS.has(t.harness))
    return state.bucket === "working" ? { bucket: "running", label: state.label } : null;
  // Running with no word for what it does (Grok records none): it runs, it is not waiting.
  if (state.bucket !== "waiting") return { bucket: "running", label: state.label };
  // Claude's own word tells a question ("esperándote") from a finished turn ("en espera");
  // the harness state says only that it waits.
  if (status === "waiting") return { bucket: "needs", urgency: "asks", label: STATUS.waiting };
  // Codex and a harness state with no Claude word: a finished turn, never a question (the
  // harness records no permission request).
  return { bucket: "needs", urgency: "idle", label: STATUS.idle };
}

// Claude's word for a session outside the app, only while its process is proven alive.
function placeOutside(s: Outside): Placed | null {
  if (s.state !== "activa") return null;
  if (s.status === "waiting") return { bucket: "needs", urgency: "asks", label: STATUS.waiting };
  if (s.status === "idle") return { bucket: "needs", urgency: "idle", label: STATUS.idle };
  return { bucket: "running", label: (s.status && STATUS[s.status]) ?? "activa" };
}

// Newest first by a field the events keep fresh; ties keep the source order.
const newest = (a: string | null | undefined, b: string | null | undefined) =>
  (b ?? "").localeCompare(a ?? "");

export function buildInbox({
  terminals = [],
  agents,
  prs = [],
  tickets = [],
}: InboxSources): Inbox {
  const inbox: Inbox = { needs: [], running: [], todo: [] };
  const place = (at: Placed | null, item: InboxItem) => {
    if (at?.bucket === "needs") inbox.needs.push({ ...item, urgency: at.urgency });
    else if (at) inbox.running.push(item);
  };
  const status = new Map(agents?.app.map((a) => [a.id, a.status]));

  for (const t of [...terminals].sort((a, b) => newest(a.startedAt, b.startedAt))) {
    const at = placeTerminal(t, status.get(t.id));
    if (at) place(at, { kind: "agent", id: t.id, label: at.label, t });
  }

  for (const s of [...(agents?.outside ?? [])].sort((a, b) => newest(a.updatedAt, b.updatedAt))) {
    const at = placeOutside(s);
    if (at) place(at, { kind: "outside", id: `${s.harness}:${s.id}`, label: at.label, s });
  }

  for (const pr of [...prs].sort((a, b) => newest(a.updatedAt, b.updatedAt))) {
    const id = `${pr.repo}#${pr.number}`;
    if (pr.kind === "review") inbox.needs.push({ kind: "pr", id, pr, urgency: "review" });
    else if (pr.kind === "mine") inbox.running.push({ kind: "pr", id, pr });
  }

  // Jira's status category, never its status names: names differ per workflow.
  for (const ticket of [...tickets].sort((a, b) => newest(a.updated, b.updated))) {
    const bucket =
      ticket.status.category === "new"
        ? "todo"
        : ticket.status.category === "indeterminate"
          ? "running"
          : null;
    if (bucket) inbox[bucket].push({ kind: "ticket", id: ticket.key, ticket });
  }
  // A stable sort: within one urgency the newest-first order above holds.
  inbox.needs.sort((a, b) => RANK[a.urgency] - RANK[b.urgency]);
  return inbox;
}

export type SourceId = "agents" | "prs" | "tickets";
export type SourceStatus = "loading" | "error" | "off" | "partial" | "ok";

// The sources each bucket is built from. A bucket is complete only when all of them were read
// whole; otherwise its emptiness says nothing and the page names the gap instead.
const READS: Record<BucketId, SourceId[]> = {
  needs: ["agents", "prs"],
  running: ["agents", "prs", "tickets"],
  todo: ["tickets"],
};

export type Coverage = {
  complete: boolean;
  gaps: { id: SourceId; status: Exclude<SourceStatus, "ok"> }[];
  // A running Codex asks for permissions without saying so: it reads as working.
  codexBlind: boolean;
};

export function coverage(
  status: Record<SourceId, SourceStatus>,
  terminals: TerminalInfo[] = [],
): Record<BucketId, Coverage> {
  const codex = terminals.some((t) => t.harness === "codex" && t.state === "running");
  const of = (bucket: BucketId): Coverage => {
    const gaps = READS[bucket].flatMap((id) => {
      const s = status[id];
      return s === "ok" ? [] : [{ id, status: s }];
    });
    const codexBlind = bucket === "needs" && codex;
    return { complete: gaps.length === 0 && !codexBlind, gaps, codexBlind };
  };
  return { needs: of("needs"), running: of("running"), todo: of("todo") };
}

// The same window the sessions scan calls "reciente" (server/features/sessions/scan.ts).
export const RECENT_MS = 10 * 60_000;

export type Change = { id: string; at: string; what: string; item: InboxItem };
