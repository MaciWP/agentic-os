import { Link, useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import type { ReactNode } from "react";
import type { OutsideAgent } from "../../../server/features/monitor/monitor.ts";
import { relativeTime } from "../../format.ts";
import { SkeletonRows } from "../../ui.tsx";
import { MAX_TILES } from "../terminals/grid-state.ts";
import { mesaSearch, ownerOf, readMesas } from "../terminals/mesas.ts";
import { shortPath } from "../terminals/panel.tsx";
import { HARNESS_LABEL, nodeKey, type TerminalInfo } from "../terminals/queries.ts";
import {
  type AgentsSnapshot,
  type AppAgent,
  type agentState,
  type Bucket,
  cpuText,
  duration,
  memText,
} from "./queries.ts";

// What both views of Agentes share: a terminal as a row, its activity strip, its facts and its
// four actions, and the notes under the lists.

export type Row = {
  t: TerminalInfo;
  a: AppAgent | undefined;
  state: ReturnType<typeof agentState>;
  place: { node: string; label: string } | undefined;
  where: string;
};

// What the page hands to either view: the rows already filtered and sorted, the sessions outside
// the app, the calls per agent, and what an action does.
export type AgentsView = {
  rows: Row[];
  outside: OutsideAgent[];
  snapshot: { pending: boolean; data: AgentsSnapshot | undefined };
  calls: (key: string) => number[] | undefined;
  now: number;
  grid: string[];
  act: (r: Row, action: "stop" | "remove") => void;
};

export const placeText = (r: Row) => r.place?.label ?? shortPath(r.t.cwd);

export const BUCKETS: { id: Bucket; title: string }[] = [
  { id: "waiting", title: "Te esperan" },
  { id: "working", title: "Trabajando" },
  { id: "unknown", title: "Sin dato" },
  { id: "failed", title: "Fallidas" },
  { id: "ended", title: "Terminadas" },
];

// One terminal, as the rows of either view need it: TerminalInfo and the agent from the poll.
type Run = { t: TerminalInfo; a?: AppAgent | undefined };

export const usageText = (cpu: number | null, rssKb: number | null) =>
  cpu === null || rssKb === null ? null : `${cpuText(cpu)} · ${memText(rssKb)}`;

// How long the terminal has run (or ran).
export function runFact(r: Run, now: number): string | null {
  const end = r.t.endedAt ? Date.parse(r.t.endedAt) : r.t.state === "running" ? now : null;
  return end === null
    ? null
    : `${r.t.endedAt ? "duró" : "lleva"} ${duration(end - Date.parse(r.t.startedAt))}`;
}

export function timeFacts(r: Run, now: number): string[] {
  const last = r.a?.lastOutputAt ?? r.t.lastOutputAt;
  const run = runFact(r, now);
  return [...(last ? [`última salida ${relativeTime(last, now)}`] : []), ...(run ? [run] : [])];
}

// What it costs, then how long it ran. A running terminal the snapshot has not reached yet says
// so with a dash, never with a zero.
export function costFacts(r: Run, now: number): string[] {
  const use = usageText(r.a?.cpu ?? null, r.a?.rssKb ?? null);
  const run = runFact(r, now);
  return [...(use ? [use] : r.t.state === "running" && !r.a ? ["—"] : []), ...(run ? [run] : [])];
}

export type Span = { start: number; end: number; last: number | null };

// When a terminal ran and last wrote, in ms; `last` is null when it never wrote.
export function spanOf(r: Run, now: number): Span {
  const start = Date.parse(r.t.startedAt);
  const end = r.t.endedAt ? Date.parse(r.t.endedAt) : now;
  const lastRaw = r.a?.lastOutputAt ?? r.t.lastOutputAt;
  return { start, end, last: lastRaw ? Math.min(Date.parse(lastRaw), end) : null };
}

const STRIP_MS = 2 * 3_600_000;
const QUIET_MS = 10 * 60_000;

// The last two hours of one agent. With a count of model calls, a bar per five minutes in the
// harness's colour; without one (a shell, an env, or no count from the server), the span it
// ran, solid up to its last output and pale after. A long silence while it waits for the user
// shows in the warning colour.
export function ActivityStrip({
  calls,
  harness,
  span,
  now,
  waiting,
  compact,
}: {
  calls: number[] | undefined;
  harness: string;
  span: Span;
  now: number;
  waiting?: boolean;
  compact?: boolean;
}) {
  const from = now - STRIP_MS;
  const pos = (ms: number) => (Math.min(Math.max(ms, from), now) - from) / STRIP_MS;
  const max = Math.max(1, ...(calls ?? []));
  const total = (calls ?? []).reduce((n, c) => n + c, 0);
  const last = span.last ?? span.start;
  const color = `var(--h-${harness}, var(--ink-2))`;
  const solid =
    ((pos(last) - pos(span.start)) / Math.max(0.001, pos(span.end) - pos(span.start))) * 100;
  return (
    <span className="flex flex-col gap-1">
      <span
        aria-hidden
        className={cn(
          "relative flex items-end gap-px border-b border-line",
          compact ? "h-4" : "h-7",
        )}
      >
        {calls ? (
          calls.map((c, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed five-minute slots
              key={i}
              className="min-w-0 flex-1 rounded-t-[1px]"
              style={{ height: c ? `${Math.max(12, (c / max) * 100)}%` : 0, background: color }}
            />
          ))
        ) : (
          <span
            className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full"
            style={{
              left: `${pos(span.start) * 100}%`,
              width: `${(pos(span.end) - pos(span.start)) * 100}%`,
              background: `linear-gradient(to right, ${color} ${solid}%, color-mix(in oklab, ${color} 25%, transparent) 0)`,
            }}
          />
        )}
      </span>
      {!compact && (
        <span className="flex justify-between gap-2 text-[11px] whitespace-nowrap text-ink-2 tabular-nums">
          <span>{calls ? `${total} llamadas · 2 h` : "últimas 2 h"}</span>
          <span
            className={cn(waiting && span.last !== null && now - last > QUIET_MS && "text-warn")}
          >
            {span.last === null
              ? "sin salida"
              : `última salida ${relativeTime(new Date(last).toISOString(), now)}`}
          </span>
        </span>
      )}
    </span>
  );
}

// See it in the Mesa, bring it to the grid, stop it, or take an ended one off the list.
export function AgentActions({
  r,
  grid,
  onAction,
}: {
  r: Row;
  grid: string[];
  onAction: (action: "stop" | "remove") => void;
}) {
  const navigate = useNavigate();
  const full = grid.length >= MAX_TILES && !grid.includes(r.t.id) && !ownerOf(readMesas(), r.t.id);
  return (
    <span className="flex shrink-0 gap-0.5">
      <Link
        to="/terminales"
        search={mesaSearch({ node: r.place?.node ?? nodeKey(r.t), t: r.t.id })}
        className="btn-ghost"
        aria-label={`Ver ${r.where}`}
      >
        Ver
      </Link>
      <button
        type="button"
        className="btn-ghost"
        disabled={full}
        title={full ? `La cuadrícula ya tiene ${MAX_TILES} terminales` : undefined}
        aria-label={`Llevar a la cuadrícula ${r.where}`}
        onClick={() => void navigate({ to: "/terminales", search: mesaSearch({ t: r.t.id }) })}
      >
        Cuadrícula
      </button>
      {r.t.state === "running" ? (
        <button
          type="button"
          className="btn-ghost"
          aria-label={`Parar ${r.where}`}
          onClick={() => onAction("stop")}
        >
          Parar
        </button>
      ) : (
        <button
          type="button"
          className="btn-ghost"
          aria-label={`Quitar ${r.where}`}
          onClick={() => onAction("remove")}
        >
          Quitar
        </button>
      )}
    </span>
  );
}

export const STATE_NOTE =
  "Claude dice su propio estado; las demás se juzgan por lo que escriben. Grok redibuja sin parar, así que no tiene dato, y un comando que no escribe (como sleep) sale en espera. La CPU y la memoria suman el proceso y sus hijos.";

export function outsideNote(missing: AgentsSnapshot["missing"]): string {
  const names = missing.map((h) => HARNESS_LABEL[h]).join(", ");
  return `Solo para ver. Codex no guarda su proceso, así que no muestra consumo.${names ? ` Sin datos de ${names}.` : ""}`;
}

// The sessions outside the app, read-only, or why there are none.
export function OutsideState({
  v,
  children,
}: {
  v: AgentsView;
  children: (list: OutsideAgent[]) => ReactNode;
}) {
  if (v.snapshot.pending) return <SkeletonRows count={2} />;
  if (!v.snapshot.data)
    return <p className="text-[12px] text-ink-2">Sin datos de las sesiones de fuera.</p>;
  if (v.outside.length === 0)
    return (
      <p className="text-[12px] text-ink-2">
        Ninguna sesión de Claude Code, Codex o Grok abierta fuera de la app.
      </p>
    );
  return <>{children(v.outside)}</>;
}

// Above this many outside sessions a view shows the first ones and says how many remain.
export const OUTSIDE_FIRST = 40;
