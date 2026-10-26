import {
  ALL,
  type Bucket,
  bucketsOf,
  type Overview,
  overviewOf,
  type TicketCost,
  ticketsOf,
} from "./ledger.ts";
import { type JiraBrief, money, tokenText, type UsageReport } from "./queries.ts";

export type Ledger = {
  o: Overview;
  tickets: TicketCost[];
  fmt: (x: number) => string;
  buckets: Bucket[];
  // The figures of the whole range, for each ticket to be read against.
  base: { perHour: number | null; perCall: number | null; cache: number };
  from: string;
  to: string;
  // No previous period: the range is the whole history.
  all: boolean;
};

export function ledgerOf(
  r: UsageReport,
  briefs: Record<string, JiraBrief | null> | null,
  now: number,
): Ledger {
  const o = overviewOf(r, now);
  const tickets = ticketsOf(r, briefs);
  const all = tickets.find((t) => t.key === ALL);
  const inSessions = all?.usage.activeHours ?? 0;
  return {
    o,
    tickets,
    fmt: (x) => (o.unit === "money" ? money(x) : `${tokenText(Math.round(x))} tokens`),
    buckets: bucketsOf(r.days),
    base: {
      perHour: inSessions > 0 ? o.amount / inSessions : null,
      perCall: r.total.calls > 0 ? o.amount / r.total.calls : null,
      cache: o.cacheShare,
    },
    from: r.from,
    to: r.to,
    all: r.previous === null,
  };
}

export const dateText = (
  ms: number,
  opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" },
) => new Date(ms).toLocaleDateString("es-ES", opts);
export const startOf = (day: string) => new Date(`${day}T00:00:00`).getTime();
export const DAY_MS = 86_400_000;
