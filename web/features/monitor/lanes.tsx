import { cn } from "cn";
import { clockTime } from "../../format.ts";
import { sessionLabel } from "../sessions/panel.tsx";
import { HarnessChip } from "../terminals/harness.tsx";
import { shortPath } from "../terminals/panel.tsx";
import { HARNESS_LABEL } from "../terminals/queries.ts";
import {
  AgentActions,
  type AgentsView,
  costFacts,
  OUTSIDE_FIRST,
  OutsideState,
  outsideNote,
  placeText,
  spanOf,
  timeFacts,
  usageText,
} from "./parts.tsx";
import type { Bucket } from "./queries.ts";

// Carriles: one lane per terminal on the same clock. The bar runs from its start to its end (or
// now), solid while it wrote and pale since it went quiet, so a stuck agent shows as a long pale
// tail and a crash as a red cap. The sessions outside the app follow, thinner, on that clock.

const HOUR = 3_600_000;
const BAR: Record<Bucket, string> = {
  working: "bg-ok",
  waiting: "bg-warn",
  failed: "bg-bad",
  unknown: "bg-ink-2",
  ended: "bg-ink-2",
};
// Who, the lane, and the actions; every row is a subgrid of it, so the lanes line up.
const COLS = "grid lg:grid-cols-[240px_minmax(0,1fr)_200px]";
const ROW = "grid lg:col-span-3 lg:grid-cols-subgrid border-t border-line";

// The clock: whole hours back to the oldest start, between 2 and 12 hours.
function windowOf(starts: number[], now: number) {
  const oldest = Math.min(now - 2 * HOUR, ...starts);
  const hours = Math.min(12, Math.max(2, Math.ceil((now - oldest) / HOUR)));
  return { from: now - hours * HOUR, hours };
}

function HourLines({ ticks, x }: { ticks: number[]; x: (ms: number) => string }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {ticks.map((t) => (
        <span key={t} className="absolute inset-y-0 w-px bg-[var(--line)]" style={{ left: x(t) }} />
      ))}
    </div>
  );
}

export function Lanes({ v }: { v: AgentsView }) {
  const now = v.now;
  const { from, hours } = windowOf(
    v.rows.map((r) => Date.parse(r.t.startedAt)),
    now,
  );
  const x = (ms: number) => `${(Math.max(0, ms - from) / (now - from)) * 100}%`;
  const w = (a: number, b: number) =>
    `${(Math.max(0, Math.min(b, now) - Math.max(a, from)) / (now - from)) * 100}%`;
  const step = hours > 6 ? 2 : 1;
  const ticks = Array.from(
    { length: Math.floor(hours / step) + 1 },
    (_, i) => now - i * step * HOUR,
  );
  const share = (part: number, whole: number) => `${(part / Math.max(1, whole)) * 100}%`;

  return (
    <div className="flex flex-col gap-8">
      <div className={COLS}>
        <div aria-hidden className="grid lg:col-span-3 lg:grid-cols-subgrid">
          <span />
          <div className="relative mb-1 h-6 text-[11px] text-ink-2 tabular-nums">
            {ticks.map((t, i) => (
              <span
                key={t}
                className={cn("absolute top-0", i === 0 ? "-translate-x-full" : "-translate-x-1/2")}
                style={{ left: x(t) }}
              >
                {i === 0 ? "ahora" : clockTime(t)}
              </span>
            ))}
          </div>
        </div>
        <ul aria-label="Agentes en la app" className="contents">
          {v.rows.map((r) => {
            const { start, end, last } = spanOf(r, now);
            const solid = Math.max(last ?? start, start) - start;
            const facts = [...costFacts(r, now).slice(0, 1), ...timeFacts(r, now)];
            return (
              <li key={r.t.id} className={ROW}>
                <div className="flex min-w-0 flex-col justify-center gap-0.5 py-2 pr-3">
                  <span className="flex min-w-0 items-center gap-2 text-[13px]">
                    <HarnessChip t={r.t} />
                    {r.t.ticket && <span className="pill shrink-0 font-mono">{r.t.ticket}</span>}
                  </span>
                  <span className="truncate font-mono text-[11px] text-ink-2" title={r.t.cwd}>
                    {placeText(r)}
                  </span>
                </div>
                <div
                  className="relative min-h-14"
                  title={`${r.state.label} · ${facts.join(" · ")}`}
                >
                  <HourLines ticks={ticks} x={x} />
                  <span
                    className="absolute top-3 h-2.5"
                    style={{ left: x(start), width: w(start, end) }}
                  >
                    <span
                      className={cn(
                        "absolute inset-y-0 left-0 rounded-l-full",
                        BAR[r.state.bucket],
                        r.state.bucket === "ended" && "opacity-50",
                      )}
                      style={{ width: share(solid, end - start) }}
                    />
                    <span
                      className={cn(
                        "absolute inset-y-0 right-0 rounded-r-full opacity-25",
                        BAR[r.state.bucket],
                      )}
                      style={{ left: share(solid, end - start) }}
                    />
                    {r.t.state === "failed" && (
                      <span className="absolute -right-1 top-1/2 size-3 -translate-y-1/2 rounded-full border-2 border-[var(--bg)] bg-bad" />
                    )}
                  </span>
                  <span className="absolute inset-x-0 bottom-1.5 truncate text-[11px] text-ink-2">
                    {r.state.label}
                    {facts.map((f) => ` · ${f}`)}
                    {r.a?.lastLine && <span className="font-mono"> · {r.a.lastLine}</span>}
                    {r.t.error && <span className="text-bad"> · {r.t.error}</span>}
                  </span>
                </div>
                <div className="flex items-center justify-end py-2">
                  <AgentActions r={r} grid={v.grid} onAction={(a) => v.act(r, a)} />
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      <section aria-label="Fuera de la app" className="flex flex-col gap-2">
        <h2 className="flex items-baseline gap-2 text-[13px] font-semibold">
          Fuera de la app
          {v.snapshot.data && (
            <span className="font-normal text-ink-2 tabular-nums">{v.outside.length}</span>
          )}
        </h2>
        <OutsideState v={v}>
          {(list) => (
            <ul aria-label="Sesiones fuera de la app" className={COLS}>
              {[...list]
                .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
                .slice(0, OUTSIDE_FIRST)
                .map((s) => {
                  const st = sessionLabel(s);
                  const end = s.updatedAt ? Date.parse(s.updatedAt) : now;
                  const start = s.startedAt ? Date.parse(s.startedAt) : end;
                  return (
                    <li key={`${s.harness}:${s.id}`} className={ROW}>
                      <div className="flex min-w-0 items-center gap-2 py-1.5 pr-3 text-[12px]">
                        <span className="font-medium">{HARNESS_LABEL[s.harness]}</span>
                        <span
                          className="truncate font-mono text-[11px] text-ink-2"
                          title={s.name ? `${s.name} · ${s.cwd}` : s.cwd}
                        >
                          {s.name ? `${s.name} · ` : ""}
                          {shortPath(s.cwd)}
                        </span>
                      </div>
                      <div className="relative min-h-8" title={st.label}>
                        <HourLines ticks={ticks} x={x} />
                        {end >= from && (
                          <span
                            className={cn(
                              "absolute top-1/2 h-1.5 min-w-1.5 -translate-y-1/2 rounded-full opacity-70",
                              st.dot,
                            )}
                            style={{ left: x(start), width: w(start, end) }}
                          />
                        )}
                      </div>
                      <div className="flex items-center justify-end py-1.5 text-[11px] text-ink-2">
                        {usageText(s.cpu, s.rssKb) ?? st.label}
                      </div>
                    </li>
                  );
                })}
            </ul>
          )}
        </OutsideState>
        {v.outside.length > OUTSIDE_FIRST && (
          <p className="text-[12px] text-ink-2">
            Las {OUTSIDE_FIRST} más recientes de {v.outside.length.toLocaleString("es-ES")}.
          </p>
        )}
        <p className="text-[11px] text-ink-2">{outsideNote(v.snapshot.data?.missing ?? [])}</p>
      </section>
    </div>
  );
}
