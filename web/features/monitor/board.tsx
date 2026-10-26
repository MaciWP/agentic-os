import { cn } from "cn";
import { relativeTime } from "../../format.ts";
import { sessionLabel } from "../sessions/panel.tsx";
import { HarnessChip } from "../terminals/harness.tsx";
import { shortPath } from "../terminals/panel.tsx";
import { HARNESS_LABEL } from "../terminals/queries.ts";
import {
  ActivityStrip,
  AgentActions,
  type AgentsView,
  BUCKETS,
  costFacts,
  OUTSIDE_FIRST,
  OutsideState,
  outsideNote,
  placeText,
  spanOf,
  usageText,
} from "./parts.tsx";

// Por estado: one column per state, from what needs the user to what is over, so the left
// edge is always the next thing to do. A column with nothing in it shrinks to its title, and
// the sessions outside the app close the board. Columns wrap rather than scroll sideways, and
// stack below lg.

const EDGE: Record<string, string> = {
  waiting: "border-l-warn",
  working: "border-l-ok",
  failed: "border-l-bad",
  unknown: "border-l-line",
  ended: "border-l-line",
};

const COLUMN = "flex min-w-0 flex-col rounded-lg lg:flex-1 lg:min-w-[250px] lg:max-w-[360px]";

export function Board({ v }: { v: AgentsView }) {
  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-start">
      {BUCKETS.map((b) => {
        const rows = v.rows.filter((r) => r.state.bucket === b.id);
        return (
          <section
            key={b.id}
            aria-label={b.title}
            className={cn(
              COLUMN,
              "bg-[color-mix(in_oklab,var(--ink)_3%,transparent)]",
              !rows.length && "lg:w-[150px] lg:min-w-0 lg:flex-none",
            )}
          >
            <h2 className="flex h-10 shrink-0 items-center gap-2 px-3 text-[13px] font-semibold">
              {b.title}
              <span className="font-normal text-ink-2 tabular-nums">{rows.length}</span>
            </h2>
            {rows.length > 0 && (
              <ul aria-label={b.title} className="flex flex-col gap-2 px-2 pb-2">
                {rows.map((r) => (
                  <li
                    key={r.t.id}
                    className={cn(
                      "flex flex-col gap-2 rounded-md border border-l-2 border-line bg-panel px-3 py-2.5 shadow-[var(--shadow-1)]",
                      EDGE[b.id],
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <HarnessChip t={r.t} />
                      {r.t.ticket && <span className="pill shrink-0 font-mono">{r.t.ticket}</span>}
                      <span className="ml-auto truncate text-[12px] text-ink-2">
                        {r.state.label}
                      </span>
                    </span>
                    <span className="truncate font-mono text-[12px]" title={r.t.cwd}>
                      {placeText(r)}
                    </span>
                    {r.a?.lastLine && (
                      <span
                        className="truncate font-mono text-[11px] text-ink-2"
                        title={r.a.lastLine}
                      >
                        {r.a.lastLine}
                      </span>
                    )}
                    {r.t.error && <span className="text-[12px] text-bad">{r.t.error}</span>}
                    <ActivityStrip
                      calls={v.calls(r.t.id)}
                      harness={r.t.harness}
                      span={spanOf(r, v.now)}
                      now={v.now}
                      waiting={b.id === "waiting"}
                    />
                    <span className="truncate text-[12px] text-ink-2 tabular-nums">
                      {costFacts(r, v.now).join(" · ")}
                    </span>
                    <span className="-mx-1 border-t border-line pt-1.5">
                      <AgentActions r={r} grid={v.grid} onAction={(a) => v.act(r, a)} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      <section
        aria-label="Fuera de la app"
        className={cn(COLUMN, "border border-dashed border-line")}
      >
        <h2 className="flex h-10 shrink-0 items-center gap-2 px-3 text-[13px] font-semibold">
          Fuera de la app
          {v.snapshot.data && (
            <span className="font-normal text-ink-2 tabular-nums">{v.outside.length}</span>
          )}
        </h2>
        <div className="flex flex-col gap-2 px-2 pb-2">
          <OutsideState v={v}>
            {(list) => (
              <ul aria-label="Sesiones fuera de la app" className="flex flex-col gap-1.5">
                {list.slice(0, OUTSIDE_FIRST).map((s) => {
                  const st = sessionLabel(s);
                  const when = s.updatedAt ?? s.startedAt;
                  const use = usageText(s.cpu, s.rssKb);
                  return (
                    <li
                      key={`${s.harness}:${s.id}`}
                      className="flex flex-col gap-1 rounded-md px-2 py-1.5 text-[12px]"
                    >
                      <span className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className={cn("size-1.5 shrink-0 rounded-full", st.dot)}
                        />
                        <span className="font-medium">{HARNESS_LABEL[s.harness]}</span>
                        <span className="truncate text-ink-2">{st.label}</span>
                        {when && (
                          <span className="ml-auto shrink-0 text-[11px] text-ink-2 tabular-nums">
                            {relativeTime(when, v.now)}
                          </span>
                        )}
                      </span>
                      <span
                        className="truncate pl-3.5 font-mono text-[11px] text-ink-2"
                        title={s.name ? `${s.name} · ${s.cwd}` : s.cwd}
                      >
                        {s.name ? `${s.name} · ` : ""}
                        {shortPath(s.cwd)}
                      </span>
                      {use && (
                        <span className="pl-3.5 font-mono text-[11px] text-ink-2">{use}</span>
                      )}
                      <span className="pl-3.5">
                        <ActivityStrip
                          calls={v.calls(`${s.harness}:${s.id}`)}
                          harness={s.harness}
                          span={{
                            start: Date.parse(s.startedAt ?? when ?? "") || v.now,
                            end: v.now,
                            last: when ? Date.parse(when) || null : null,
                          }}
                          now={v.now}
                          compact
                        />
                      </span>
                    </li>
                  );
                })}
                {list.length > OUTSIDE_FIRST && (
                  <li className="px-2 text-[12px] text-ink-2">
                    y {(list.length - OUTSIDE_FIRST).toLocaleString("es-ES")} más
                  </li>
                )}
              </ul>
            )}
          </OutsideState>
          <p className="px-2 text-[11px] text-ink-2">
            {outsideNote(v.snapshot.data?.missing ?? [])}
          </p>
        </div>
      </section>
    </div>
  );
}
