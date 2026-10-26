import { relativeTime } from "../../format.ts";
import { Icon } from "../../icons.tsx";
import { isOff } from "../../ui.tsx";
import { places, useProjects } from "../projects/queries.ts";
import { useTickets } from "../tickets/queries.ts";
import { useWaiting } from "./attention.tsx";
import { isPanel } from "./grid-state.ts";
import { projectOf } from "./mesa-blocks.ts";
import {
  isAutoName,
  type MesaState,
  mesaTopic,
  splitName,
  ticketBadge,
  type Workspace,
} from "./mesas.ts";
import {
  mesaPhase,
  type Phase,
  PhaseIcon,
  phaseOf,
  rowText,
  shortPath,
  standingOf,
  standingRank,
  WAIT_KINDS,
  type WaitCount,
  type WaitKind,
  WaitPill,
  waitCount,
} from "./panel.tsx";
import { type TerminalInfo, useTerminals } from "./queries.ts";

// What every surface says about a Mesa (its rail card, its Mosaico cell, its Lienzo frame):
// its name, where it stands and the terminal it speaks for.
export type MesaSummary = {
  mesa: MesaState;
  // In words, for notices and dialogs: the badge, then the text.
  label: string;
  // The card's name: its tickets as a badge, then what is being done.
  badge: string | null;
  text: string;
  icon: string | null;
  phase: Phase | null;
  count: number;
  // What of it waits for the user, by kind.
  waits: WaitCount;
  // Where it stands (panel.tsx `standingRank`): its most pressing terminal's, done when empty.
  rank: number;
  // The terminal the card speaks for: its most pressing one.
  lead: TerminalInfo | null;
  // The loudest wait, for the chip and the tint; null when nothing waits but a turn looked at.
  loud: WaitKind | null;
  // What the lead asks, else the start of the last thing it said.
  line: string | null;
  project: string | null;
  // Where its terminals work: in its tooltip and for screen readers.
  where: string;
  hover: string;
  // Why the phase is not shown: the terminals are not read yet, or their read failed.
  unknown: string | null;
};

function summarize(
  mesa: MesaState,
  all: TerminalInfo[],
  waiting: ReadonlySet<string>,
  unknown: string | null,
  placeOf: Map<string, { label: string }>,
  summaries: ReadonlyMap<string, string>,
  projects: Parameters<typeof projectOf>[1] | undefined,
): MesaSummary {
  const own = mesa.ids.flatMap((id) => (isPanel(id) ? [] : all.filter((t) => t.id === id)));
  const { icon, base } = splitName(mesa.name);
  const { tickets, goal } = mesaTopic(mesa, all);
  const badge = ticketBadge(tickets);
  // Beside the badge, what is being done: the name the user gave the Mesa, else its ticket's
  // summary, its goal, or what its terminals call themselves; «Mesa N» only with nothing else.
  const said =
    (tickets[0] && summaries.get(tickets[0])) ||
    goal ||
    own.find((t) => t.name)?.name ||
    own.find((t) => t.agent?.title)?.agent?.title ||
    null;
  const text = !isAutoName(mesa.name) ? base : (said ?? (badge ? "" : base));
  const label = badge ? (text ? `${badge} · ${text}` : badge) : text;
  const ranked = own
    .map((t) => ({ t, rank: standingRank(standingOf(t, waiting)) }))
    .sort((a, b) => a.rank - b.rank);
  const lead = ranked[0]?.t ?? null;
  const waits = waitCount(own, waiting);
  const project =
    (projects &&
      [lead, ...own].flatMap((t) => (t ? [projectOf(t, projects)] : [])).find(Boolean)) ||
    null;
  return {
    mesa,
    label,
    badge,
    text,
    icon,
    phase: mesaPhase(own),
    count: mesa.ids.filter((id) => waiting.has(id)).length,
    waits,
    rank: ranked[0]?.rank ?? 6,
    lead,
    loud: WAIT_KINDS.find((k) => waits[k] > 0) ?? null,
    line: lead?.agent?.question ?? lead?.agent?.lastMessage ?? null,
    project,
    where: [...new Set(own.map((t) => placeOf.get(t.id)?.label ?? shortPath(t.cwd)))].join(" · "),
    hover: unknown
      ? `${label}\n${unknown}`
      : [label, ...own.map((t) => `· ${rowText(t)}: ${phaseOf(t).label}`)].join("\n"),
    unknown,
  };
}

// Every Mesa's summary, with what they were read from.
export function useMesaSummaries(workspace: Workspace) {
  const waiting = useWaiting();
  const read = useTerminals();
  const terminals = read.data?.terminals ?? [];
  // Rule 3: unread terminals are not "no phase"; each card says its state is unknown.
  const unknown = read.data
    ? null
    : read.isError
      ? "No se ha podido leer el estado de las terminales"
      : "Leyendo el estado de las terminales…";
  const projects = useProjects().data;
  const placeOf = projects ? places(terminals, projects) : new Map<string, { label: string }>();
  const ticketList = useTickets().data;
  const summaries = new Map(
    ticketList && !isOff(ticketList) ? ticketList.tickets.map((t) => [t.key, t.summary]) : [],
  );
  const views = workspace.mesas.map((mesa) =>
    summarize(mesa, terminals, waiting, unknown, placeOf, summaries, projects),
  );
  return { views, read, terminals, waiting, projects, placeOf };
}

// When the lead last did something, for a card's second line.
export const mesaAge = (v: MesaSummary) => {
  if (v.phase?.key === "working") return "trabajando…";
  const at = v.lead?.lastOutputAt ?? v.lead?.endedAt ?? v.lead?.startedAt;
  return at ? relativeTime(at) : "";
};

// Where a Mesa stands, at the end of its name: why it waits (and how many more), a spinner while
// it works, or how it ended. `wide`: the wait's words always show. What the marks cannot say
// goes to screen readers.
export function MesaStatus({ v, wide = false }: { v: MesaSummary; wide?: boolean }) {
  const done = v.rank === 6 && !!v.lead;
  const extra = v.loud ? Object.values(v.waits).reduce((n, c) => n + c, 0) - 1 : 0;
  const ended = done && v.lead ? phaseOf(v.lead) : null;
  return (
    <>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {v.loud ? (
          <>
            <WaitPill kind={v.loud} wide={wide} />
            {extra > 0 && (
              <span className="text-[11px] text-ink-2 tabular-nums">
                +{extra}
                <span className="sr-only"> más</span>
              </span>
            )}
          </>
        ) : v.phase?.key === "working" ? (
          <PhaseIcon phase={v.phase} pulse={false} title={v.phase.label} />
        ) : ended?.key === "failed" ? (
          <PhaseIcon phase={ended} pulse={false} title={ended.label} />
        ) : (
          ended && (
            <span aria-hidden title="Terminada" className="grid text-ok">
              <Icon name="done" size={12} />
            </span>
          )
        )}
      </span>
      {!v.loud && (v.phase?.icon || ended) && (
        <span className="sr-only">({ended ? ended.label : v.phase?.label})</span>
      )}
      {v.unknown && (
        <span className="text-ink-2" title={v.unknown}>
          …<span className="sr-only"> ({v.unknown})</span>
        </span>
      )}
    </>
  );
}
