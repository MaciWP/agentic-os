import { cn } from "cn";
import type { ReactNode } from "react";
import { HARNESS_LABEL } from "../terminals/queries.ts";
import type { Delta } from "./ledger.ts";

// The small figures Consumo is drawn with: shares, a change against before, a trend line and
// a harness split.

export const share = (part: number, whole: number) => (whole > 0 ? part / whole : 0);
const PCT = new Intl.NumberFormat("es-ES", { style: "percent", maximumFractionDigits: 1 });
export const PCT0 = new Intl.NumberFormat("es-ES", { style: "percent", maximumFractionDigits: 0 });
// A share as text ("30,4 %") and as a CSS width ("30.4%"): the text form is not valid CSS.
export const pct = (n: number) => PCT.format(n);
const TIMES = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 });
export const widthOf = (n: number) => `${n * 100}%`;

export const harnessName = (h: string) => HARNESS_LABEL[h as keyof typeof HARNESS_LABEL] ?? h;

// ▲ 34 % in warn when spending grew past a quarter, ▼ in ok when it fell as much; "nuevo" when
// there was nothing before. `against` says what it is compared with.
export function DeltaText({
  d,
  className,
  against = "Frente al mismo número de días justo antes",
}: {
  d: Delta;
  className?: string;
  against?: string;
}) {
  if (!d) return null;
  if (d.kind === "new")
    return <span className={cn("text-[11px] text-ink-2", className)}>nuevo</span>;
  const up = d.value > 0;
  const big = Math.abs(d.value) >= 0.25;
  return (
    <span
      className={cn(
        "text-[11px] whitespace-nowrap tabular-nums",
        big ? (up ? "text-warn" : "text-ok") : "text-ink-2",
        className,
      )}
      title={against}
    >
      {Math.abs(d.value) < 0.005
        ? "="
        : // Ten times or more reads as a factor: "×337", not "33.640 %".
          `${up ? "▲" : "▼"} ${d.value >= 9 ? `×${TIMES.format(d.value + 1)}` : PCT0.format(Math.abs(d.value))}`}
    </span>
  );
}

// A small area chart of a series, oldest on the left. A null is a gap with nothing to measure,
// never a zero; a point with no neighbour draws a dot.
export function Spark({
  values,
  className,
  color = "var(--accent)",
}: {
  values: (number | null)[];
  className?: string;
  color?: string;
}) {
  const max = Math.max(...values.map((x) => x ?? 0), 0);
  const n = values.length;
  const x = (i: number) => (n === 1 ? 50 : (i / (n - 1)) * 100);
  const y = (v: number) => (max > 0 ? 28 - (v / max) * 26 : 28);
  const runs: { i: number; v: number }[][] = [];
  values.forEach((v, i) => {
    if (v === null) return;
    const last = runs.at(-1);
    const prev = last?.at(-1);
    if (last && prev && prev.i === i - 1) last.push({ i, v });
    else runs.push([{ i, v }]);
  });
  return (
    <svg
      aria-hidden
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      className={cn("h-7 w-full overflow-visible", className)}
    >
      {runs.map((run) => {
        const first = run[0];
        if (!first) return null;
        if (run.length === 1)
          return <circle key={first.i} cx={x(first.i)} cy={y(first.v)} r="1.5" fill={color} />;
        const pts = run.map((p) => `${x(p.i)},${y(p.v)}`).join(" ");
        return (
          <g key={first.i}>
            <polygon
              points={`${x(first.i)},30 ${pts} ${x(run.at(-1)?.i ?? first.i)},30`}
              style={{ fill: `color-mix(in oklab, ${color} 18%, transparent)` }}
            />
            <polyline
              points={pts}
              fill="none"
              stroke={color}
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />
          </g>
        );
      })}
    </svg>
  );
}

// The share of each harness as one thin strip.
export function HarnessStrip({
  parts,
  className,
}: {
  parts: [string, number][];
  className?: string;
}) {
  const total = parts.reduce((n, [, x]) => n + x, 0);
  return (
    <span
      className={cn("flex h-1.5 overflow-hidden rounded-full bg-[var(--hover)]", className)}
      title={parts.map(([h, x]) => `${harnessName(h)} ${PCT0.format(share(x, total))}`).join(" · ")}
    >
      {parts.map(([h, x]) => (
        <span
          key={h}
          style={{ width: widthOf(share(x, total)), background: `var(--h-${h}, var(--ink-2))` }}
        />
      ))}
    </span>
  );
}

export type Bar = {
  key: string;
  label: ReactNode;
  // The label as plain text, for the title of a cut one.
  text: string;
  value: number;
  valueText: string;
  color?: string;
};

// A ranked list as bars: name, a bar as long as its share of the largest, and the figure. With
// `onPick`, each row is a button pressed while it is `picked`.
export function BarList({
  label,
  bars,
  empty,
  picked,
  onPick,
}: {
  label: string;
  bars: Bar[];
  empty: string;
  picked?: string | null;
  onPick?: (key: string) => void;
}) {
  if (bars.length === 0) return <p className="px-3 py-3 text-[12px] text-ink-2">{empty}</p>;
  const max = Math.max(...bars.map((b) => b.value), 0);
  return (
    <ul aria-label={label} className="flex flex-col py-1 text-[12px]">
      {bars.map((b) => {
        const body = (
          <>
            {b.color && (
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-[2px]"
                style={{ background: b.color }}
              />
            )}
            <span className="w-[38%] min-w-0 shrink-0 truncate text-left" title={b.text}>
              {b.label}
            </span>
            <span className="h-2 min-w-0 flex-1 rounded-r-[4px] bg-[var(--hover)]">
              <span
                className="block h-full rounded-r-[4px]"
                style={{
                  width: widthOf(share(b.value, max)),
                  background: b.color ?? "var(--cat-1)",
                }}
              />
            </span>
            <span className="min-w-24 shrink-0 text-right font-mono whitespace-nowrap tabular-nums">
              {b.valueText}
            </span>
          </>
        );
        const row = "flex w-full items-center gap-2 px-3 py-1";
        return (
          <li key={b.key}>
            {onPick ? (
              <button
                type="button"
                aria-pressed={picked === b.key}
                className={cn(
                  row,
                  "rounded-md hover:bg-[var(--hover)] aria-pressed:bg-[var(--selected)]",
                )}
                onClick={() => onPick(b.key)}
              >
                {body}
              </button>
            ) : (
              <div className={row}>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
