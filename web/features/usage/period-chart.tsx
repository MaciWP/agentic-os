import { cn } from "cn";
import { type PointerEvent, useState } from "react";
import type { QuotaSample } from "../../../server/features/usage/types.ts";
import { harnessName } from "./charts.tsx";
import type { Pace, Series } from "./period-view.ts";

const HOUR = 3_600_000;
const x = (h: number, hours: number) => (h / hours) * 100;

const hourText = (ms: number) =>
  new Date(ms).toLocaleString("es-ES", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

// Local midnights inside the period, as hour offsets: every day in a week, every week in a month.
function dayTicks(start: number, hours: number): { h: number; label: string }[] {
  const out: { h: number; label: string }[] = [];
  for (let h = 0; h <= hours; h++) {
    const d = new Date(start + h * HOUR);
    if (d.getHours() !== 0 || d.getMinutes() !== 0) continue;
    out.push({ h, label: d.toLocaleDateString("es-ES", { weekday: "short", day: "numeric" }) });
  }
  return hours > 8 * 24 ? out.filter((_, i) => i % 7 === 0) : out;
}

export type ChartSeries = Series & { label: string; color: string };

// The running total of the period, one band per series stacked on the ones below, with the
// period before as a dashed ghost, the pace carried to the end as a dashed line and the hour
// under the pointer read out. One axis: the amount.
export function PeriodChart({
  series,
  hours,
  elapsed,
  start,
  previous,
  path,
  fmt,
  label,
}: {
  series: ChartSeries[];
  hours: number;
  elapsed: number;
  start: number;
  previous: number[];
  // The projection from now to the end, hour by hour, with the range of the weeks before.
  path: Pace["path"];
  fmt: (n: number) => string;
  label: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const shown = Math.max(1, elapsed);
  const total = (h: number) => series.reduce((n, s) => n + (s.cum[h] ?? 0), 0);
  const end = total(shown - 1);
  const top = Math.max(end, ...path.high, ...previous.slice(0, hours), 0) * 1.05 || 1;
  const y = (v: number) => 100 - (v / top) * 100;
  // The projection starts where the spend stands now.
  const ahead = (values: number[]) => [
    `${x(shown, hours)},${y(end)}`,
    ...values.map((v, i) => `${x(shown + i + 1, hours)},${y(v)}`),
  ];
  const band = path.mid.length ? [...ahead(path.high), ...ahead(path.low).reverse()].join(" ") : "";
  // Each band from the top of the one below to its own; the hour's end is where its spend lands.
  const bands: { s: ChartSeries; points: string }[] = [];
  const base = Array(shown).fill(0) as number[];
  for (const s of series) {
    const upper = base.map((b, h) => b + (s.cum[h] ?? 0));
    const up = upper.map((v, h) => `${x(h + 1, hours)},${y(v)}`);
    const down = base.map((v, h) => `${x(h + 1, hours)},${y(v)}`).reverse();
    bands.push({ s, points: [`0,${y(0)}`, ...up, ...down, `0,${y(0)}`].join(" ") });
    upper.forEach((v, h) => {
      base[h] = v;
    });
  }
  const ghost = previous
    .slice(0, hours)
    .map((v, h) => `${x(h + 1, hours)},${y(v)}`)
    .join(" ");
  const grid = [0.5, 1].map((f) => top * f);
  const ticks = dayTicks(start, hours);
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const h = Math.floor(((e.clientX - box.left) / box.width) * hours);
    setHover(Math.min(shown - 1, Math.max(0, h)));
  };
  const at = hover ?? null;
  return (
    <figure className="flex flex-col gap-1" aria-label={label}>
      <div className="flex">
        <div
          className="relative h-[220px] flex-1 border-b border-line"
          onPointerMove={move}
          onPointerLeave={() => setHover(null)}
        >
          {grid.map((v) => (
            <div
              key={v}
              aria-hidden
              className="absolute inset-x-0 border-t border-dashed border-line"
              style={{ top: `${y(v)}%` }}
            >
              <span className="absolute -top-2 right-0 bg-bg pl-1 text-[11px] text-ink-2 tabular-nums">
                {fmt(v)}
              </span>
            </div>
          ))}
          <svg
            aria-hidden
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="absolute inset-0 size-full overflow-visible"
          >
            {bands.map(({ s, points }) => (
              <polygon
                key={s.key}
                points={points}
                fill={s.color}
                fillOpacity={0.85}
                stroke="var(--bg)"
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
              />
            ))}
            {ghost && (
              <polyline
                points={`0,100 ${ghost}`}
                fill="none"
                stroke="var(--ink-2)"
                strokeWidth="1.5"
                strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
              />
            )}
            {band && <polygon points={band} fill="var(--ink-2)" fillOpacity={0.12} />}
            {path.mid.length > 0 && (
              <polyline
                points={ahead(path.mid).join(" ")}
                fill="none"
                stroke="var(--ink)"
                strokeWidth="1.5"
                strokeDasharray="5 4"
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
              />
            )}
            {elapsed < hours && (
              <line
                x1={x(shown, hours)}
                x2={x(shown, hours)}
                y1={0}
                y2={100}
                stroke="var(--line)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            )}
            {at !== null && (
              <line
                x1={x(at + 1, hours)}
                x2={x(at + 1, hours)}
                y1={0}
                y2={100}
                stroke="var(--ink-2)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          {at !== null && (
            <Tip
              at={at}
              hours={hours}
              start={start}
              series={series}
              total={total(at)}
              before={previous[at] ?? null}
              fmt={fmt}
            />
          )}
        </div>
      </div>
      <div aria-hidden className="relative h-4 text-[11px] text-ink-2">
        {ticks.map((t) => (
          <span
            key={t.h}
            className="absolute -translate-x-1/2 whitespace-nowrap"
            style={{ left: `${x(t.h, hours)}%` }}
          >
            {t.label}
          </span>
        ))}
      </div>
    </figure>
  );
}

function Tip({
  at,
  hours,
  start,
  series,
  total,
  before,
  fmt,
}: {
  at: number;
  hours: number;
  start: number;
  series: ChartSeries[];
  total: number;
  before: number | null;
  fmt: (n: number) => string;
}) {
  const left = x(at + 1, hours);
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute top-2 z-10 flex w-60 flex-col gap-1 rounded-md border border-line bg-panel px-3 py-2 text-[12px] shadow-[var(--shadow-2)]",
        left > 60 ? "-translate-x-[calc(100%+8px)]" : "translate-x-2",
      )}
      style={{ left: `${left}%` }}
    >
      <span className="text-ink-2">hasta {hourText(start + (at + 1) * HOUR)}</span>
      <span className="flex justify-between font-semibold tabular-nums">
        <span>Total</span>
        {fmt(total)}
      </span>
      {series.map((s) => (
        <span key={s.key} className="flex items-center gap-2 tabular-nums">
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-[2px]"
            style={{ background: s.color }}
          />
          <span className="min-w-0 flex-1 truncate" title={s.label}>
            {s.label}
          </span>
          {fmt(s.cum[at] ?? 0)}
        </span>
      ))}
      {before !== null && (
        <span className="flex justify-between border-t border-line pt-1 text-ink-2 tabular-nums">
          <span>Periodo anterior</span>
          {fmt(before)}
        </span>
      )}
    </div>
  );
}

// How full each plan's quota was, on the chart's own clock: a step per sample, the limit as a
// rule. Its own chart, so a percent never shares an axis with money.
export function QuotaStrip({
  samples,
  start,
  hours,
  elapsed,
}: {
  samples: QuotaSample[];
  start: number;
  hours: number;
  elapsed: number;
}) {
  const span = hours * HOUR;
  // Each harness's longest window: Claude's week, not its five hours.
  const longest = new Map<string, number>();
  for (const s of samples) longest.set(s.harness, Math.max(longest.get(s.harness) ?? 0, s.minutes));
  const byHarness = new Map<string, QuotaSample[]>();
  for (const s of samples)
    if (s.percent !== null && s.minutes === longest.get(s.harness))
      byHarness.set(s.harness, [...(byHarness.get(s.harness) ?? []), s]);
  const now = x(elapsed, hours);
  return (
    <div className="flex flex-col gap-1">
      <div className="relative h-14 border-b border-line">
        <div aria-hidden className="absolute inset-x-0 top-0 border-t border-dashed border-bad/60">
          <span className="absolute -top-2 right-0 bg-bg pl-1 text-[11px] text-ink-2">100 %</span>
        </div>
        <svg
          aria-hidden
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 size-full overflow-visible"
        >
          {[...byHarness].map(([harness, list]) => {
            const pts: string[] = [];
            list.forEach((s, i) => {
              const px = ((Date.parse(s.at) - start) / span) * 100;
              const py = 100 - (s.percent ?? 0);
              const prev = list[i - 1];
              if (prev) pts.push(`${px},${100 - (prev.percent ?? 0)}`);
              pts.push(`${px},${py}`);
            });
            const last = list.at(-1);
            if (last) pts.push(`${now},${100 - (last.percent ?? 0)}`);
            return (
              <polyline
                key={harness}
                points={pts.join(" ")}
                fill="none"
                stroke={`var(--h-${harness}, var(--ink-2))`}
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
              />
            );
          })}
        </svg>
      </div>
      <p className="flex flex-wrap gap-3 text-[11px] text-ink-2">
        {[...byHarness].map(([harness, list]) => (
          <span key={harness} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-0.5 w-3"
              style={{ background: `var(--h-${harness}, var(--ink-2))` }}
            />
            {harnessName(harness)} {list.at(-1)?.percent} % de la cuota
          </span>
        ))}
      </p>
    </div>
  );
}
