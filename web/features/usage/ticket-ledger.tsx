import { cn } from "cn";
import { plural, relativeTime } from "../../format.ts";
import { DeltaText, HarnessStrip, Spark } from "./charts.tsx";
import { ALL, sumBuckets, type TicketCost } from "./ledger.ts";
import type { Ledger } from "./ledger-view.ts";
import { Head, TicketDetail, TicketName } from "./ticket-detail.tsx";

const lastText = (t: TicketCost, now: number) =>
  t.usage.last ? relativeTime(t.usage.last, now) : "—";

function Row({
  L,
  t,
  now,
  picked,
  onPick,
}: {
  L: Ledger;
  t: TicketCost;
  now: number;
  picked: boolean;
  onPick: () => void;
}) {
  const series = sumBuckets(t.daily, L.buckets);
  return (
    <button
      type="button"
      aria-current={picked ? "true" : undefined}
      onClick={onPick}
      className={cn(
        "flex w-full flex-col gap-2 rounded-md px-3 py-2.5 text-left text-[13px]",
        picked ? "bg-[var(--selected)]" : "hover:bg-[var(--hover)]",
      )}
    >
      <span className="flex items-start justify-between gap-3">
        <TicketName t={t} />
        <span className="shrink-0 font-mono tabular-nums">{L.fmt(t.amount)}</span>
      </span>
      <span className="grid grid-cols-[72px_minmax(0,1fr)_52px] items-center gap-3 text-[11px] text-ink-2">
        {series.length > 1 ? (
          <Spark values={series} className="h-5" color={t.key ? "var(--accent)" : "var(--warn)"} />
        ) : (
          <span />
        )}
        <span className="flex min-w-0 items-center gap-2">
          <HarnessStrip parts={t.byHarness} className="w-14 shrink-0" />
          <span className="truncate">{lastText(t, now)}</span>
        </span>
        <DeltaText d={t.delta} className="text-right" />
      </span>
    </button>
  );
}

// The ticket picked in the URL: "none" is the work with no ticket, nothing is all of them.
export const pickedKey = (ticket: string | undefined) =>
  ticket === undefined ? ALL : ticket === "none" ? "" : ticket;
export const ticketParam = (key: string) => (key === ALL ? undefined : key === "" ? "none" : key);

export function TicketLedger({
  L,
  now,
  picked,
  onPick,
  story = null,
}: {
  L: Ledger;
  now: number;
  picked: string;
  onPick: (key: string) => void;
  // The picked ticket over its whole history, when it has been read: shown instead of its
  // share of the period.
  story?: { L: Ledger; t: TicketCost } | null;
}) {
  const t = L.tickets.find((x) => x.key === picked) ?? L.tickets[0];
  if (!t) return <p className="text-[13px] text-ink-2">Sin llamadas en este periodo.</p>;
  const shown = story && story.t.key === t.key ? story : { L, t };
  const all = L.tickets.find((x) => x.key === ALL);
  const owned = L.tickets.filter((x) => x.key && x.key !== ALL);
  const none = L.tickets.find((x) => !x.key);
  return (
    <div className="grid gap-10 lg:grid-cols-[420px_minmax(0,1fr)]">
      <nav
        aria-label="Tickets"
        className="flex max-h-[calc(100vh-17rem)] min-h-[24rem] flex-col self-start rounded-lg border border-line"
      >
        {all && (
          <div className="border-b border-line p-1.5">
            <Row L={L} t={all} now={now} picked={t.key === ALL} onPick={() => onPick(ALL)} />
          </div>
        )}
        <p className="flex justify-between px-4 pt-2 pb-1 text-[11px] text-ink-2">
          <span>{plural(owned.length, "ticket", "tickets")}</span>
          <span>tendencia · con qué{L.all ? "" : " · vs. antes"}</span>
        </p>
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5 pt-0">
          {owned.map((x) => (
            <Row
              key={x.key}
              L={L}
              t={x}
              now={now}
              picked={x.key === t.key}
              onPick={() => onPick(x.key)}
            />
          ))}
        </div>
        {none && (
          <div
            className="border-t border-line p-1.5"
            style={{ background: "color-mix(in oklab, var(--warn) 6%, transparent)" }}
          >
            <Row L={L} t={none} now={now} picked={!t.key} onPick={() => onPick("")} />
          </div>
        )}
      </nav>
      <article
        aria-label={t.key === ALL ? "Todos los tickets" : (t.goal ?? t.key) || "Sin ticket"}
        className="flex min-w-0 flex-col gap-7"
      >
        {story && shown === story && (
          <p className="text-[12px] text-ink-2">Toda su historia, no solo este periodo.</p>
        )}
        <Head L={shown.L} t={shown.t} whole={shown === story} />
        <TicketDetail key={t.key} L={shown.L} t={shown.t} now={now} />
      </article>
    </div>
  );
}
