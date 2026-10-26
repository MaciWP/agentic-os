import { cn } from "cn";
import { type ReactNode, useState } from "react";
import { plural } from "../../format.ts";
import { errorText, InlineError } from "../../ui.tsx";
import type { TicketRow } from "../tickets/groups.ts";
import { StatusIcon } from "../tickets/icons.tsx";
import { type DeskDocs, foldersOf, LEVEL, TICKETS_SHOWN } from "./desk-model.ts";
import { type Filter, keysOf, type Tk } from "./desk-tickets.ts";
import { dayKey, dayLabel, NONE, shortDate } from "./journal.ts";
import type { DocSummary } from "./queries.ts";

export function TicketMark({ k, t }: { k: string; t: TicketRow | undefined }) {
  if (t) return <StatusIcon status={t.status.name} category={t.status.category} />;
  return (
    <span
      aria-hidden
      className={cn(
        "size-[14px] shrink-0 rounded-full border border-dashed",
        k === NONE ? "border-transparent" : "border-ink-2/60",
      )}
    />
  );
}

// Thirteen Monday-first weeks up to today, one cell per day, shaded by the notes that changed.
function Heat({
  docs,
  now,
  picked,
  onPick,
}: {
  docs: DocSummary[];
  now: number;
  picked: string | null;
  onPick: (day: string) => void;
}) {
  const counts = new Map<string, number>();
  for (const d of docs) counts.set(dayKey(d.mtime), (counts.get(dayKey(d.mtime)) ?? 0) + 1);
  const today = new Date(`${dayKey(now)}T12:00:00`);
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7) - 12 * 7);
  const days = Array.from({ length: 13 * 7 }, (_, i) => {
    const x = new Date(monday);
    x.setDate(monday.getDate() + i);
    return x;
  });
  const level = (n: number) => (n === 0 ? 0 : n === 1 ? 1 : n === 2 ? 2 : n <= 4 ? 3 : 4);
  const inRange = days.reduce((n, x) => n + (counts.get(dayKey(x.getTime())) ?? 0), 0);
  return (
    <section aria-label="Actividad" className="flex flex-col gap-2 px-2.5">
      <div className="grid grid-flow-col grid-rows-7 gap-[3px]">
        {days.map((x) => {
          const day = dayKey(x.getTime());
          if (x > today) return <span key={day} className="size-[13px]" />;
          const n = counts.get(day) ?? 0;
          const text = `${dayLabel(day, now)}, ${shortDate(day)}: ${plural(n, "nota", "notas")}`;
          return (
            <button
              key={day}
              type="button"
              aria-label={text}
              title={text}
              aria-pressed={picked === day}
              onClick={() => onPick(day)}
              style={{ background: LEVEL[level(n)] }}
              className={cn(
                "size-[13px] rounded-[3px]",
                picked === day && "ring-2 ring-ink ring-offset-1 ring-offset-[var(--bg)]",
              )}
            />
          );
        })}
      </div>
      <p className="flex items-center gap-1 text-[11px] text-ink-2">
        <span className="mr-auto tabular-nums">
          {plural(inRange, "nota", "notas")} · 13 semanas
        </span>
        {LEVEL.map((l) => (
          <span key={l} aria-hidden className="size-2 rounded-[2px]" style={{ background: l }} />
        ))}
      </p>
    </section>
  );
}

function RailItem({
  active,
  onClick,
  children,
  count,
  className,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  count: number;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1 text-left text-[13px]",
        active ? "bg-[var(--selected)]" : "hover:bg-[var(--hover)]",
        className,
      )}
    >
      {children}
      <span className="ml-auto shrink-0 text-[12px] text-ink-2 tabular-nums">
        {count.toLocaleString("es-ES")}
      </span>
    </button>
  );
}

const RailHead = ({ children }: { children: ReactNode }) => (
  <h2 className="px-2.5 pt-5 pb-1 text-[11px] font-medium text-ink-2">{children}</h2>
);

function RailTickets({
  all,
  tk,
  is,
  toggle,
}: {
  all: DocSummary[];
  tk: Tk;
  is: (kind: "ticket", value: string) => boolean;
  toggle: (kind: "ticket", value: string) => void;
}) {
  const [allTickets, setAllTickets] = useState(false);
  const { jira } = tk;
  if (jira.state === "loading")
    return <p className="px-2.5 text-[12px] text-ink-2">Cargando tus tickets…</p>;
  if (jira.state === "off")
    return <p className="px-2.5 text-[12px] text-ink-2">Jira no está configurado.</p>;
  if (jira.state === "error")
    return (
      <InlineError className="px-2.5 text-[12px]">
        Sin tus tickets de Jira: {errorText(jira.error)}{" "}
        <button type="button" className="btn-ghost" onClick={jira.retry}>
          Reintentar
        </button>
      </InlineError>
    );
  const counts = new Map<string, number>();
  for (const x of all) for (const k of keysOf(x, tk)) counts.set(k, (counts.get(k) ?? 0) + 1);
  const keys = [...counts]
    .filter(([k]) => k !== NONE)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = allTickets ? keys : keys.slice(0, TICKETS_SHOWN);
  return (
    <>
      {keys.length === 0 && (
        <p className="px-2.5 text-[12px] text-ink-2">Ninguna nota nombra un ticket.</p>
      )}
      {shown.map(([k, n]) => {
        const t = tk.of(k);
        return (
          <RailItem key={k} active={is("ticket", k)} onClick={() => toggle("ticket", k)} count={n}>
            <TicketMark k={k} t={t} />
            <span
              className="truncate font-mono text-[12.5px] whitespace-nowrap"
              title={t ? `${k} · ${t.summary} · ${t.status.name}` : `${k} · ${tk.absent}`}
            >
              {k}
            </span>
          </RailItem>
        );
      })}
      {keys.length > TICKETS_SHOWN && (
        <button
          type="button"
          className="btn-ghost mx-2.5 mt-0.5 self-start text-[12px] text-ink-2"
          onClick={() => setAllTickets(!allTickets)}
        >
          {allTickets ? "Ver menos" : `Ver ${keys.length - TICKETS_SHOWN} más`}
        </button>
      )}
      {counts.has(NONE) && (
        <RailItem
          active={is("ticket", NONE)}
          onClick={() => toggle("ticket", NONE)}
          count={counts.get(NONE) ?? 0}
          className="text-ink-2"
        >
          <TicketMark k={NONE} t={undefined} />
          {NONE}
        </RailItem>
      )}
    </>
  );
}

export function Rail({
  d,
  all,
  now,
  filter,
  setFilter,
  tk,
}: {
  d: DeskDocs;
  all: DocSummary[];
  now: number;
  filter: Filter;
  setFilter: (f: Filter) => void;
  tk: Tk;
}) {
  const is = (kind: NonNullable<Filter>["kind"], value: string) =>
    filter?.kind === kind && filter.value === value;
  const toggle = (kind: NonNullable<Filter>["kind"], value: string) =>
    setFilter(is(kind, value) ? null : { kind, value });
  const today = dayKey(now);
  return (
    <nav
      aria-label="Filtros"
      className="hidden shrink-0 flex-col overflow-y-auto border-r border-line px-2 pt-6 pb-16 md:flex md:w-[232px]"
    >
      <h1 className="px-2.5 pb-3 text-[20px] font-semibold tracking-[-0.01em]">Notas y memoria</h1>
      <RailItem active={!filter} onClick={() => setFilter(null)} count={all.length}>
        Todo
      </RailItem>
      <RailItem
        active={is("day", today)}
        onClick={() => toggle("day", today)}
        count={all.filter((x) => dayKey(x.mtime) === today).length}
      >
        Hoy
      </RailItem>
      <RailHead>Actividad</RailHead>
      <Heat
        docs={all}
        now={now}
        picked={filter?.kind === "day" ? filter.value : null}
        onPick={(day) => toggle("day", day)}
      />
      <RailHead>Tickets</RailHead>
      <RailTickets all={all} tk={tk} is={is} toggle={toggle} />
      <RailHead>Fuentes</RailHead>
      {foldersOf(d).map((f, i) => (
        <div key={f.id}>
          {i === 3 && (
            <p className="px-2.5 pt-2 pb-1 text-[11px] text-ink-2">
              Memoria de los harnesses · solo lectura
            </p>
          )}
          <RailItem
            active={is("source", f.id)}
            onClick={() => toggle("source", f.id)}
            count={f.count}
            className={f.note ? "text-ink-2" : undefined}
          >
            <span className="truncate">{f.label}</span>
            {f.note && <span className="shrink-0 text-[11px]">{f.note}</span>}
          </RailItem>
        </div>
      ))}
    </nav>
  );
}
