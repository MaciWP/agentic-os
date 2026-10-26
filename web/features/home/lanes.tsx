import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { type ComponentType, useState } from "react";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { plural } from "../../format.ts";
import { SkeletonRows } from "../../ui.tsx";
import type { TicketRow } from "../tickets/groups.ts";
import { JiraStatus } from "../tickets/icons.tsx";
import { ageText, type Case, casesOf, interruptCount, SourceProblems, State } from "./cases.tsx";
import type { InboxData } from "./data.ts";
import type { Urgency } from "./inbox.ts";
import { byTicket, type Linked } from "./join.ts";
import { ago, Who } from "./parts.tsx";

// Inicio, ticket by ticket. Each ticket is a lane that holds what moves on it (its agents, its
// PR), so the day reads as tickets, not as a list of processes. Whatever names no ticket gets
// its own lane, so a waiting agent is never hidden. The view takes its data and the action each
// case ends in, so the app and the prototypes draw the same thing.

const RULE: Record<Urgency, string> = {
  failed: "before:bg-bad",
  asks: "before:bg-warn",
  review: "before:bg-primary",
  idle: "before:bg-ink-2/50",
};

const STATUS = "text-[12px] whitespace-nowrap text-ink-2";

const RANK: Record<Urgency, number> = { failed: 0, asks: 1, review: 2, idle: 3 };
const rank = (u: Urgency | null) => (u === null ? 4 : RANK[u]);

// A count read from sources that did not all answer is a floor, and a zero from them says
// nothing: "al menos 2 …" or the gap, never "0 …".
export const known = (complete: boolean, n: number, one: string, many: string, gap: string) =>
  complete ? plural(n, one, many) : n === 0 ? gap : `al menos ${plural(n, one, many)}`;

type Lane = {
  id: string;
  ticket: TicketRow | null;
  goal?: { id: number; title: string };
  items: Case[];
  urgency: Urgency | null;
};

// The action a case ends in: a navigation in the app, a selection in the prototypes.
export type CaseActionView = ComponentType<{ c: Case; className?: string }>;

export function Lanes({
  data,
  tickets,
  Action,
  selectedId = null,
}: {
  data: InboxData;
  tickets: TicketRow[];
  Action: CaseActionView;
  selectedId?: string | null;
}) {
  const cases = casesOf(data);
  const byId = new Map(cases.map((c) => [c.id, c]));
  const caseOf = (l: Linked) => byId.get(`${l.item.kind}:${l.item.id}`);
  const { work, goals, loose } = byTicket(tickets, data.inbox);

  const lanes: Lane[] = work.map((w) => ({
    id: w.ticket.key,
    ticket: w.ticket,
    items: w.items.flatMap((l) => caseOf(l) ?? []),
    urgency: w.urgency,
  }));
  for (const g of goals)
    lanes.push({
      id: `goal:${g.goal.id}`,
      ticket: null,
      goal: g.goal,
      items: g.items.flatMap((l) => caseOf(l) ?? []),
      urgency: g.urgency,
    });
  const looseCases = loose.flatMap((l) => caseOf(l) ?? []);
  if (looseCases.length > 0) {
    const urgency = loose.map((l) => l.urgency).sort((a, b) => rank(a) - rank(b))[0] ?? null;
    lanes.push({ id: "loose", ticket: null, items: looseCases, urgency });
  }
  // A lane with something on it comes first, by what it holds; the quiet ones go to the end.
  const busy = lanes
    .filter((l) => l.items.length > 0)
    .sort((a, b) => rank(a.urgency) - rank(b.urgency));
  const quiet = lanes.filter((l) => l.items.length === 0);
  const interrupts = interruptCount(data);
  // Nothing to show while a source still loads or failed is not "nothing to do": the failure
  // is said above, and the empty message waits for every source.
  const reading = data.sources.some((s) => s.state === "loading" || s.state === "error");
  const partial = data.sources.some((s) => s.state === "partial");

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[1360px] flex-col gap-6 px-6 pt-6 pb-28">
        <header>
          <h1 className="text-[22px] font-semibold tracking-[-0.01em]">Ticket a ticket</h1>
          <p className="mt-1 text-ink-2">
            {known(
              data.coverage.running.complete,
              busy.filter((l) => l.ticket).length,
              "ticket con algo en marcha",
              "tickets con algo en marcha",
              "faltan datos para saber qué hay en marcha",
            )}{" "}
            ·{" "}
            {data.coverage.needs.complete && interrupts === 0
              ? "nada te interrumpe"
              : known(
                  data.coverage.needs.complete,
                  interrupts,
                  "cosa te interrumpe",
                  "cosas te interrumpen",
                  "faltan datos para saber si algo te interrumpe",
                )}
          </p>
        </header>
        <SourceProblems data={data} />
        {lanes.length === 0 && reading ? (
          <SkeletonRows count={4} />
        ) : lanes.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>
                {partial ? "Sin tickets ni agentes en lo leído" : "Sin tickets ni agentes"}
              </EmptyTitle>
              <EmptyDescription>
                {partial
                  ? "Falta una parte de los datos (arriba): lo que no se ha leído no sale aquí."
                  : "Cuando Jira te asigne algo o arranques un agente, aparecerá aquí."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ol className="flex flex-col gap-3" aria-label="Tickets con trabajo">
            {busy.map((l) => (
              <LaneRow
                key={l.id}
                lane={l}
                selectedId={selectedId}
                now={data.now}
                cases={cases}
                Action={Action}
              />
            ))}
          </ol>
        )}
        {quiet.length > 0 && (
          <section className="flex flex-col gap-1">
            <h2 className="px-1 pb-1 text-[11px] font-semibold tracking-wide text-ink-2 uppercase">
              Sin nada en marcha{data.coverage.running.complete ? "" : " (faltan datos)"} ·{" "}
              {quiet.length}
            </h2>
            <ul className="overflow-hidden rounded-lg border border-line">
              {quiet.map((l) =>
                l.ticket ? (
                  <li
                    key={l.id}
                    className="grid h-10 grid-cols-[96px_minmax(0,1fr)_minmax(0,220px)_96px_auto] items-center gap-4 border-b border-line px-4 last:border-b-0"
                  >
                    <span className="font-mono text-[12px] text-ink-2">{l.ticket.key}</span>
                    <span className="truncate" title={l.ticket.summary}>
                      {l.ticket.summary}
                    </span>
                    <JiraStatus status={l.ticket.status} className={STATUS} />
                    <span className="text-right text-[12px] text-ink-2">
                      {ago(l.ticket.updated, data.now)}
                    </span>
                    <TicketAction t={l.ticket} cases={cases} Action={Action} />
                  </li>
                ) : null,
              )}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

// The ticket's own action goes through its case, so it behaves like every other one.
function TicketAction({
  t,
  cases,
  Action,
}: {
  t: TicketRow;
  cases: Case[];
  Action: CaseActionView;
}) {
  const c = cases.find((x) => x.id === `ticket:${t.key}`);
  return c ? <Action c={c} /> : <span />;
}

function LaneRow({
  lane,
  selectedId,
  now,
  cases,
  Action,
}: {
  lane: Lane;
  selectedId: string | null;
  now: number;
  cases: Case[];
  Action: CaseActionView;
}) {
  const { ticket, goal, items, urgency } = lane;
  const [all, setAll] = useState(false);
  return (
    <li
      className={cn(
        "relative grid grid-cols-1 overflow-hidden rounded-lg border border-line bg-panel md:grid-cols-[300px_minmax(0,1fr)]",
        "before:absolute before:inset-y-0 before:left-0 before:w-[3px]",
        urgency ? RULE[urgency] : "before:bg-transparent",
      )}
    >
      <div className="flex flex-col gap-2 border-b border-line px-5 py-4 md:border-r md:border-b-0">
        {ticket ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="shrink-0 font-mono text-[12px] whitespace-nowrap text-ink-2">
                {ticket.key}
              </span>
              <JiraStatus status={ticket.status} className={STATUS} />
            </div>
            <p className="line-clamp-2 text-[14px] leading-snug font-medium" title={ticket.summary}>
              {ticket.summary}
            </p>
            <div className="mt-auto flex items-center justify-between gap-3 pt-1">
              <span className="text-[12px] text-ink-2">
                {plural(items.length, "pieza", "piezas")} · {ago(ticket.updated, now)}
              </span>
              <TicketAction t={ticket} cases={cases} Action={Action} />
            </div>
          </>
        ) : goal ? (
          <>
            <span className="text-[12px] text-ink-2">Objetivo</span>
            <p className="line-clamp-2 text-[14px] leading-snug font-medium" title={goal.title}>
              {goal.title}
            </p>
            <div className="mt-auto flex items-center justify-between gap-3 pt-1">
              <span className="text-[12px] text-ink-2">
                {plural(items.length, "pieza", "piezas")}
              </span>
              <Link
                to="/consumo"
                search={{ ticket: `goal:${goal.id}` }}
                className="text-[12px] text-ink-2 hover:text-ink"
              >
                Consumo
              </Link>
            </div>
          </>
        ) : (
          <>
            <span className="text-[12px] text-ink-2">Sin ticket</span>
            <p className="text-[14px] leading-snug font-medium">
              Agentes y PR que no nombran ninguno de tus tickets
            </p>
          </>
        )}
      </div>
      <div className="flex flex-col gap-2 p-3">
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(224px,1fr))] content-start gap-2">
          {(all ? items : items.slice(0, PIECES_SHOWN)).map((c) => (
            <Piece key={c.id} c={c} selected={c.id === selectedId} now={now} Action={Action} />
          ))}
        </ul>
        {items.length > PIECES_SHOWN && (
          <button
            type="button"
            className="btn-ghost self-start text-ink-2"
            aria-expanded={all}
            onClick={() => setAll(!all)}
          >
            {all ? "Ver menos" : `Ver las ${items.length}`}
          </button>
        )}
      </div>
    </li>
  );
}

// A lane shows its most urgent pieces first; past this many, the rest wait behind a button so
// a pile of old sessions with no ticket never buries the tickets below it.
const PIECES_SHOWN = 8;

// One agent, session or PR on the lane: who, its state, how long, and what to do.
function Piece({
  c,
  selected,
  now,
  Action,
}: {
  c: Case;
  selected: boolean;
  now: number;
  Action: CaseActionView;
}) {
  return (
    <li
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-md border bg-bg px-3 py-2.5",
        selected ? "border-primary" : "border-line",
      )}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="flex min-w-0">
          <Who s={c.s} />
        </span>
        <State c={c} />
      </div>
      <p
        className={cn("truncate text-[12px]", c.error ? "font-mono text-bad" : "text-ink-2")}
        title={c.error ?? c.s.title}
      >
        {c.error ?? c.s.title}
      </p>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] text-ink-2 tabular-nums">{ageText(c, now)}</span>
        <Action c={c} />
      </div>
    </li>
  );
}
