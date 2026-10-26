import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { JiraBrief } from "../../../server/features/usage/briefs.ts";
import type { JudgeRun } from "../../../server/features/usage/judge.ts";
import type {
  HookLine,
  TicketUsage,
  UsageLine,
  UsagePeriod,
  UsageReport,
  UsageSession,
} from "../../../server/features/usage/types.ts";
import { dayOf, daysBefore } from "../../../shared/days.ts";
import { api, mutate, unwrap } from "../../api.ts";
import { pollEvery } from "../../poll.ts";

export type { HookLine, JiraBrief, TicketUsage, UsageLine, UsagePeriod, UsageReport, UsageSession };
export { dayOf, daysBefore };

// The period the whole page reads: a quota week or a calendar month, `offset` back from the
// current one. `ticket`: the one open in the detail, "none" for the work with no ticket; none
// for every ticket at once. `tab`: the topic shown under the chart; none for spend.
export const USAGE_TABS = ["gasto", "modelos", "logpose", "router", "salud", "inventario"] as const;
export type UsageTab = (typeof USAGE_TABS)[number];
export type UsageSearch = {
  kind?: UsagePeriod["kind"];
  offset?: number;
  ticket?: string;
  tab?: UsageTab;
};
export type PeriodPick = { kind: UsagePeriod["kind"]; offset: number };
export const periodOf = (search: UsageSearch): PeriodPick => ({
  kind: search.kind ?? "week",
  offset: search.offset ?? 0,
});

// The server reads new transcript lines before answering when its last read is a minute old.
export const USAGE_POLL_MS = 60_000;
// While the effort judge runs, its count moves every call or so.
export const JUDGE_POLL_MS = 10_000;

// The period's report, read while the page is open; the poll pauses while the tab is hidden.
// The one shown stays while the next loads.
export const useUsage = ({ kind, offset }: PeriodPick) =>
  useQuery({
    queryKey: ["usage", kind, offset],
    queryFn: async () =>
      unwrap(await api.api.usage.$get({ query: { kind, offset: String(offset) } })),
    refetchInterval: (q) => (q.state.data?.logPose?.judge.running ? JUDGE_POLL_MS : USAGE_POLL_MS),
    placeholderData: (before) => before,
  });

// The whole history, for the story of one ticket: its life does not fit in one week.
export const useUsageHistory = (enabled: boolean) =>
  useQuery({
    queryKey: ["usage", "all", dayOf(new Date())],
    enabled,
    queryFn: async () => unwrap(await api.api.usage.$get({ query: { to: dayOf(new Date()) } })),
    refetchInterval: pollEvery(USAGE_POLL_MS),
  });

// A quota week or a calendar month, `offset` periods back; the one shown stays while the next
// loads, so moving through periods never blanks the chart.
export const usePeriod = (kind: UsagePeriod["kind"], offset: number) =>
  useQuery({
    queryKey: ["usage-period", kind, offset],
    queryFn: async () =>
      unwrap(await api.api.usage.period.$get({ query: { kind, offset: String(offset) } })),
    refetchInterval: pollEvery(USAGE_POLL_MS),
    placeholderData: (before) => before,
  });

// A pass of the effort judge over a span: it runs on in the server, and the page's poll reads
// it.
export function useJudge() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (span: { from: string; to: string }) =>
      mutate<{ run: JudgeRun }>("/api/usage/effort-judge", "POST", span),
    onSettled: () => client.invalidateQueries({ queryKey: ["usage"] }),
  });
}

// The Jira title and status of each key; the server keeps them ten minutes.
export const useJiraBriefs = (keys: string[]) =>
  useQuery({
    queryKey: ["usage-jira", keys],
    enabled: keys.length > 0,
    queryFn: async () => unwrap(await api.api.usage.jira.$get({ query: { keys: keys.join(",") } })),
    staleTime: 5 * 60_000,
  });

const USD = new Intl.NumberFormat("es-ES", { style: "currency", currency: "USD" });
const ONE = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 });

export const money = (cost: number | null) => (cost === null ? "—" : USD.format(cost));

// 950 · 12,3 k · 1.585,2 M: millions keep growing, so a billion still reads as millions.
export function tokenText(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${ONE.format(n / 1e3)} k`;
  return `${ONE.format(n / 1e6)} M`;
}

export const totalTokens = (l: UsageLine) =>
  l.tokens.input + l.tokens.cacheRead + l.tokens.cacheWrite + l.tokens.output;

export const tokenTitle = (l: UsageLine) =>
  `entrada ${tokenText(l.tokens.input)} · caché leída ${tokenText(l.tokens.cacheRead)} · caché escrita ${tokenText(l.tokens.cacheWrite)} · salida ${tokenText(l.tokens.output)}`;
