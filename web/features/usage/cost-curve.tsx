import { cn } from "cn";
import { harnessName, share, widthOf } from "./charts.tsx";
import { amountOf, type Bucket, sumBuckets, type TicketCost } from "./ledger.ts";
import { DAY_MS, dateText, type Ledger, startOf } from "./ledger-view.ts";

// Bars by day (by week past three months), and under them the running total with a dot where
// each session ended.
export function CostCurve({ L, t }: { L: Ledger; t: TicketCost }) {
  const values = sumBuckets(t.daily, L.buckets);
  const n = values.length;
  if (n < 2)
    return (
      <p className="rounded-md border border-dashed border-line px-4 py-6 text-[12px] text-ink-2">
        Con un solo día no hay curva que contar: la línea de tiempo dice cuándo se gastó. Elige 7
        días o más para ver cómo crece.
      </p>
    );
  const weekly = L.buckets.length !== t.daily.length;
  const total = values.reduce((a, b) => a + b, 0);
  const max = Math.max(...values, 0);
  const cum: number[] = [];
  values.reduce((a, b, i) => {
    cum[i] = a + b;
    return a + b;
  }, 0);
  const start = startOf(L.from);
  const y = (x: number) => (total > 0 ? 100 - (x / total) * 100 : 100);
  const points = [`0,100`, ...cum.map((c, i) => `${((i + 1) / n) * 100},${y(c)}`)].join(" ");
  // A session's end sits in its bar, as far along it as its time is along the bar's days.
  const dots = t.usage.sessions.flatMap((s) => {
    const at = Date.parse(s.last);
    const day = Math.floor((at - start) / DAY_MS);
    const i = L.buckets.findIndex((b) => day >= b.from && day < b.from + b.days);
    const b = L.buckets[i];
    if (!b) return [];
    const within = Math.min(1, Math.max(0, (at - (start + b.from * DAY_MS)) / (b.days * DAY_MS)));
    const c = (cum[i - 1] ?? 0) + (values[i] ?? 0) * within;
    return [{ s, left: ((i + within) / n) * 100, top: y(c) }];
  });
  const labels = [0, Math.floor((n - 1) / 2), n - 1];
  const barTitle = (b: Bucket, x: number) =>
    `${weekly ? `Semana del ${dateText(startOf(b.day), { day: "numeric", month: "long" })}` : dateText(startOf(b.day), { weekday: "long", day: "numeric", month: "long" })}: ${L.fmt(x)}`;
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="flex items-baseline justify-between text-[11px] text-ink-2">
        <span>
          <span
            aria-hidden
            className="mr-1.5 inline-block size-2 rounded-[2px] bg-[var(--cat-other)]"
          />
          por {weekly ? "semana" : "día"} · máx. {L.fmt(max)}
        </span>
        <span>
          <span aria-hidden className="mr-1.5 inline-block h-0.5 w-3 bg-primary align-middle" />
          acumulado · {L.fmt(total)}
        </span>
      </figcaption>
      {/* Two plots on one clock, each with its own scale: a day's spend and the running total
          never share an axis. */}
      <ol
        aria-label={weekly ? "Por semana" : "Por día"}
        className="flex h-[96px] items-end gap-px border-b border-line"
      >
        {L.buckets.map((b, i) => (
          <li
            key={b.day}
            className="min-w-0 flex-1 rounded-t-[2px] bg-[var(--cat-other)]"
            style={{ height: widthOf(share(values[i] ?? 0, max)) }}
            title={barTitle(b, values[i] ?? 0)}
          />
        ))}
      </ol>
      <div className="relative h-[120px] border-b border-line">
        <svg
          aria-hidden
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 size-full overflow-visible"
        >
          <polyline
            points={points}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
          />
        </svg>
        {dots.map(({ s, left, top }) => (
          <span
            key={s.key}
            title={`${s.terminal ?? harnessName(s.harness)} · ${L.fmt(amountOf(s, L.o.unit))} · terminó ${dateText(Date.parse(s.last), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`}
            className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-[var(--bg)]"
            style={{
              left: `${left}%`,
              top: `${top}%`,
              background: `var(--h-${s.harness}, var(--ink-2))`,
            }}
          />
        ))}
      </div>
      <div className="relative h-4 text-[11px] text-ink-2">
        {labels.map((i) => (
          <span
            key={i}
            className={cn(
              "absolute whitespace-nowrap",
              i === 0 ? "left-0" : i === n - 1 ? "right-0" : "-translate-x-1/2",
            )}
            style={i !== 0 && i !== n - 1 ? { left: `${((i + 0.5) / n) * 100}%` } : undefined}
          >
            {dateText(startOf(L.buckets[i]?.day ?? L.from))}
          </span>
        ))}
      </div>
    </figure>
  );
}
