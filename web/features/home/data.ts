import { isOff } from "../../ui.tsx";
import { useAgents } from "../monitor/queries.ts";
import { usePullRequests } from "../prs/panel.tsx";
import { HARNESS_LABEL, type TerminalInfo, useTerminals } from "../terminals/queries.ts";
import { useTickets } from "../tickets/queries.ts";
import { type BucketId, buildInbox, type Coverage, coverage, type Inbox } from "./inbox.ts";

// How one source was read. A failed or partial source is said beside the buckets, so an empty
// bucket never stands for a fetch that failed.
export type SourceState =
  | { state: "loading" }
  | { state: "error"; error: unknown; retry: () => void }
  | { state: "off" }
  | { state: "partial"; problems: string[] }
  | { state: "ok" };

export type Source = { id: "agents" | "prs" | "tickets"; label: string } & SourceState;

export type InboxData = {
  inbox: Inbox;
  // Every terminal the app runs or ran, for what started or ended lately.
  terminals: TerminalInfo[];
  sources: Source[];
  coverage: Record<BucketId, Coverage>;
  now: number;
};

type Read<T> = {
  isError: boolean;
  isPending: boolean;
  error: unknown;
  data?: T;
  refetch: () => unknown;
};

// Agents come from two reads: the terminals and the session scan. Until both arrive the
// source is loading, never "ok" with nothing in it.
export function agentsSource(
  terminals: Read<unknown>,
  agents: Read<{ missing: readonly (keyof typeof HARNESS_LABEL)[] }>,
): SourceState {
  if (terminals.isError)
    return { state: "error", error: terminals.error, retry: () => terminals.refetch() };
  if (terminals.isPending) return { state: "loading" };
  if (agents.isError) return { state: "error", error: agents.error, retry: () => agents.refetch() };
  if (agents.isPending) return { state: "loading" };
  if (agents.data && agents.data.missing.length > 0)
    return {
      state: "partial",
      problems: [`Sin datos de ${agents.data.missing.map((h) => HARNESS_LABEL[h]).join(", ")}`],
    };
  return { state: "ok" };
}

export function useInboxData(): InboxData {
  const terminals = useTerminals();
  const agents = useAgents();
  const prs = usePullRequests();
  const tickets = useTickets();

  const prData = prs.data && !isOff(prs.data) ? prs.data : undefined;
  const ticketData = tickets.data && !isOff(tickets.data) ? tickets.data : undefined;
  const inbox = buildInbox({
    terminals: terminals.data?.terminals,
    agents: agents.data,
    prs: prData?.prs,
    tickets: ticketData?.tickets,
  });

  const agentsState = agentsSource(terminals, agents);

  const prState: SourceState = prs.isPending
    ? { state: "loading" }
    : prs.isError
      ? { state: "error", error: prs.error, retry: () => prs.refetch() }
      : isOff(prs.data)
        ? { state: "off" }
        : prs.data.errors.length > 0
          ? { state: "partial", problems: prs.data.errors }
          : { state: "ok" };

  const ticketState: SourceState = tickets.isPending
    ? { state: "loading" }
    : tickets.isError
      ? { state: "error", error: tickets.error, retry: () => tickets.refresh() }
      : isOff(tickets.data)
        ? { state: "off" }
        : { state: "ok" };

  return {
    inbox,
    terminals: terminals.data?.terminals ?? [],
    coverage: coverage(
      { agents: agentsState.state, prs: prState.state, tickets: ticketState.state },
      terminals.data?.terminals,
    ),
    sources: [
      { id: "agents", label: "Agentes", ...agentsState },
      { id: "prs", label: "GitHub", ...prState },
      { id: "tickets", label: "Jira", ...ticketState },
    ],
    now: Date.now(),
  };
}
