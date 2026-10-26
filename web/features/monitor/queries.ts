import { useQuery } from "@tanstack/react-query";
import type { AgentsSnapshot, AppAgent } from "../../../server/features/monitor/monitor.ts";
import type { Activity } from "../../../server/features/usage/activity.ts";
import { api, unwrap } from "../../api.ts";
import { pollEvery } from "../../poll.ts";
import { STATUS } from "../sessions/panel.tsx";
import { AGENT_STATE, STATE } from "../terminals/panel.tsx";
import type { TerminalInfo } from "../terminals/queries.ts";

export type { AgentsSnapshot, AppAgent };

export const AGENTS_POLL_MS = 5000;

// What each process costs and Claude's own word, read while the page is open. The query pauses
// while the tab is hidden (refetchIntervalInBackground stays off); state and activity come
// from the terminals list, which events keep fresh.
export const agentsOptions = {
  queryKey: ["agents"],
  queryFn: async () => unwrap(await api.api.agents.$get()),
  refetchInterval: pollEvery(AGENTS_POLL_MS),
};

export const useAgents = () => useQuery(agentsOptions);

export const ACTIVITY_POLL_MS = 30_000;

// Model calls per agent over the last two hours, five minutes to a bar. The server reads new
// transcript lines first when its last read is older than this interval; hidden tabs pause.
export const activityOptions = {
  queryKey: ["agents-activity"],
  queryFn: async (): Promise<Activity> => unwrap(await api.api.usage.activity.$get()),
  refetchInterval: pollEvery(ACTIVITY_POLL_MS),
};

export const useActivity = () => useQuery(activityOptions);

export type Bucket = "working" | "waiting" | "unknown" | "ended" | "failed";

// What a terminal is doing, as one word. The agent's state from the list (ADR 0008) wins, then
// Claude's own status from the poll, then the output: the program's word beats a byte count.
// An ended terminal says how it ended, never "en espera".
export function agentState(
  t: TerminalInfo,
  status: string | null | undefined,
): { bucket: Bucket; label: string; dot: string } {
  if (t.state === "exited") return { bucket: "ended", ...STATE.exited };
  if (t.state !== "running") return { bucket: "failed", ...STATE[t.state] };
  if (t.agent?.state === "working") return { bucket: "working", ...AGENT_STATE.working };
  if (t.agent?.state === "needs_you") return { bucket: "waiting", ...AGENT_STATE.needs_you };
  if (status === "busy") return { bucket: "working", label: STATUS.busy, dot: "bg-ok" };
  if (status === "waiting") return { bucket: "waiting", label: STATUS.waiting, dot: "bg-warn" };
  if (status === "idle") return { bucket: "waiting", label: STATUS.idle, dot: "border border-ok" };
  // Any other word (none seen so far) leaves it to the output.
  if (t.activity === "busy") return { bucket: "working", label: "trabajando", dot: "bg-ok" };
  if (t.activity === "idle")
    return { bucket: "waiting", label: "en espera", dot: "border border-ok" };
  return { bucket: "unknown", label: "sin dato de actividad", dot: "border border-ink-2" };
}

const ORDER: Record<Bucket, number> = { working: 0, waiting: 1, unknown: 2, failed: 3, ended: 4 };

// Working first, then the ones waiting, then the ended. Only fields the events keep fresh sort
// the rows, and ties keep the start order, so a row never moves under the pointer on a poll.
export function sortAgents(
  terminals: TerminalInfo[],
  status: (t: TerminalInfo) => string | null | undefined,
) {
  const rank = new Map(terminals.map((t) => [t.id, ORDER[agentState(t, status(t)).bucket]]));
  return [...terminals].sort(
    (a, b) =>
      (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0) ||
      b.startedAt.localeCompare(a.startedAt) ||
      a.id.localeCompare(b.id),
  );
}

export function countAgents(
  terminals: TerminalInfo[],
  status: (t: TerminalInfo) => string | null | undefined,
): Record<Bucket, number> {
  const counts = { working: 0, waiting: 0, unknown: 0, ended: 0, failed: 0 };
  for (const t of terminals) counts[agentState(t, status(t)).bucket]++;
  return counts;
}

// "45 s", "12 min", "2 h 5 min".
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

const nf = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 });

export const cpuText = (cpu: number) => `${nf.format(cpu)} % CPU`;

export function memText(rssKb: number): string {
  const mb = rssKb / 1024;
  return mb >= 1024 ? `${nf.format(mb / 1024)} GB` : `${Math.round(mb)} MB`;
}
