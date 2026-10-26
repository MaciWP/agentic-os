import { Link, useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import type { Pr } from "../../../server/features/github/prs.ts";
import { relativeTime } from "../../format.ts";
import { type Kickoff, kickoffText } from "../kickoff/kickoff.tsx";
import { groupByStatus, type TicketRow } from "./groups.ts";
import { JiraStatus, StatusIcon, TypeIcon } from "./icons.tsx";
import { Estimate } from "./list.tsx";
import { Avatar } from "./people.tsx";

// Whose tickets the board shows: the user's own (no `w`), the whole team's, one person's
// (their Jira accountId), or nobody's. `b` is the Jira board, the first configured one when
// absent.
export type Who = undefined | "all" | "none" | (string & {});
export type TicketsSearch = { w?: string; b?: string };

// A board column as data/config.json copies it from Jira: its name and the status ids it holds.
export type Column = { name: string; statuses: string[] };

export const shownBy = (who: Who, t: TicketRow) =>
  who === "all" ? true : who === "none" ? !t.assignee : t.assignee?.accountId === who;

// What the board needs to say about a ticket beside the ticket itself.
export type BoardFacts = {
  isMine: (t: TicketRow) => boolean;
  prsOf: (key: string) => Pr[];
  envOf: (key: string) => string | null;
  // The ticket's last «Empezar» or «Revisar a fondo», while it runs or after it failed.
  kickoffOf?: (key: string) => Kickoff | undefined;
};

// The board's tickets as the filter sees it: loaded, still loading, or not there (off, or
// failed: the page says why below, with its retry).
export type TeamRead =
  | { state: "ok"; tickets: TicketRow[]; isMine: (t: TicketRow) => boolean }
  | { state: "loading" }
  | { state: "off" };

// Goes to the board view, or to the open ticket, with this search.
function useGo(ticketKey: string | undefined) {
  const navigate = useNavigate();
  return (search: TicketsSearch) =>
    ticketKey
      ? void navigate({ to: "/tickets/$key", params: { key: ticketKey }, search })
      : void navigate({ to: "/tickets", search });
}

function Chip({
  pressed,
  onClick,
  label,
  count,
  name,
}: {
  pressed: boolean;
  onClick: () => void;
  label: string;
  count: number | null;
  name?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 max-w-[220px] shrink-0 items-center gap-2 rounded-md px-2.5 text-[12px]",
        pressed ? "bg-[var(--selected)] text-ink" : "text-ink-2 hover:bg-[var(--hover)]",
      )}
      title={name}
    >
      {name && <Avatar name={name} />}
      <span className="truncate">{label}</span>
      {count !== null && <span className="text-ink-2 tabular-nums">{count}</span>}
    </button>
  );
}

// Which Jira board the page shows; switching keeps `w`.
export function BoardSwitch({
  boards,
  shown,
  who,
  ticketKey,
}: {
  boards: { id: string; name: string }[];
  shown: string | undefined;
  who: Who;
  ticketKey: string | undefined;
}) {
  const go = useGo(ticketKey);
  if (boards.length < 2) return null;
  return (
    <div role="toolbar" aria-label="Tablero" className="flex flex-wrap items-center gap-1">
      {boards.map((b) => (
        <Chip
          key={b.id}
          pressed={b.id === shown}
          onClick={() => go({ w: who, b: b.id })}
          label={b.name}
          count={null}
        />
      ))}
    </div>
  );
}

export function WhoFilter({
  who,
  board,
  mine,
  team,
  ticketKey,
}: {
  who: Who;
  board: string | undefined;
  mine: number | null;
  team: TeamRead;
  ticketKey: string | undefined;
}) {
  const go = useGo(ticketKey);
  const chip = (id: Who, label: string, count: number | null, name?: string) => (
    <Chip
      key={id ?? "me"}
      pressed={who === id}
      onClick={() => go({ w: id, b: board })}
      label={label}
      count={count}
      name={name}
    />
  );
  const people = new Map<string, { id: string; name: string; count: number }>();
  if (team.state === "ok")
    for (const t of team.tickets) {
      if (!t.assignee || team.isMine(t)) continue;
      const p = people.get(t.assignee.accountId);
      if (p) p.count++;
      else
        people.set(t.assignee.accountId, {
          id: t.assignee.accountId,
          name: t.assignee.displayName,
          count: 1,
        });
    }
  const sorted = [...people.values()].sort((a, b) => a.name.localeCompare(b.name, "es"));
  const unassigned = team.state === "ok" ? team.tickets.filter((t) => !t.assignee).length : 0;
  return (
    <div role="toolbar" aria-label="De quién" className="flex flex-wrap items-center gap-1">
      {chip(undefined, "Míos", mine)}
      {team.state === "ok" && (
        <>
          {chip("all", "Todo el equipo", team.tickets.length)}
          <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-[var(--line)]" />
          {sorted.map((p) => chip(p.id, p.name.split(" ")[0] ?? p.name, p.count, p.name))}
          {unassigned > 0 && chip("none", "Sin asignar", unassigned)}
        </>
      )}
      {team.state === "loading" && (
        <span className="px-2 text-[12px] text-ink-2">Cargando el tablero…</span>
      )}
    </div>
  );
}

// The fact a card closes with: a kickoff running or failed, a PR waiting for a reviewer first, then the PR, the env that
// works on the ticket, or when it last changed.
function cardFact(t: TicketRow, f: BoardFacts) {
  const k = f.kickoffOf?.(t.key);
  if (k && k.state !== "ok")
    return {
      text: k.state === "running" ? "arrancando…" : "arranque falló",
      warn: k.state === "failed",
      title: kickoffText(k),
    };
  const pr = f.prsOf(t.key)[0];
  if (pr && !pr.draft && t.reviewers.length === 0)
    return {
      text: "sin revisor",
      warn: true,
      title: `${pr.repo}#${pr.number} sin revisor en Jira`,
    };
  if (pr) {
    const text = `#${pr.number}${pr.draft ? " · borrador" : ""}`;
    return { text, warn: false, title: `${pr.repo}#${pr.number} ${pr.title}` };
  }
  const env = f.envOf(t.key);
  if (env) return { text: env, warn: false, title: `Entorno ${env}` };
  return {
    text: relativeTime(t.updated),
    warn: false,
    title: new Date(t.updated).toLocaleString("es"),
  };
}

// The board's columns in Jira's order, every one even when empty, each with its tickets in
// the order they came (the board's rank). Tickets in no column are not on the board.
export function boardColumns<T extends Pick<TicketRow, "status">>(
  columns: Column[],
  tickets: T[],
): { name: string; statuses: string[]; tickets: T[] }[] {
  return columns.map((c) => ({
    ...c,
    tickets: tickets.filter((t) => c.statuses.includes(t.status.id)),
  }));
}

// One column per board column, or per Jira status when the board has no columns. Columns wrap
// rather than scroll sideways, and stack below md. A column of several statuses names each
// card's status.
export function Board({
  tickets,
  columns,
  picked,
  search,
  facts,
}: {
  tickets: TicketRow[];
  columns: Column[] | null;
  picked: string | undefined;
  search: TicketsSearch;
  facts: BoardFacts;
}) {
  const shown = columns
    ? boardColumns(columns, tickets)
    : groupByStatus(tickets).map((g) => ({ name: g.status, statuses: [g.status], ...g }));
  return (
    <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-start">
      {shown.map((g) => (
        <section
          key={g.name}
          aria-label={g.name}
          className="flex min-w-0 flex-col rounded-lg bg-[color-mix(in_oklab,var(--ink)_3%,transparent)] md:min-w-[240px] md:max-w-[340px] md:flex-1"
        >
          <h2 className="flex h-10 shrink-0 items-center gap-2 px-3 text-[13px] font-semibold">
            {g.statuses.length === 1 && g.tickets[0] && (
              <StatusIcon status={g.name} category={g.tickets[0].status.category} />
            )}
            <span className="truncate" title={g.name}>
              {g.name}
            </span>
            <span className="font-normal text-ink-2 tabular-nums">{g.tickets.length}</span>
          </h2>
          <ul className="flex flex-col gap-2 px-2 pb-2">
            {g.tickets.map((t) => {
              const fact = cardFact(t, facts);
              return (
                <li key={t.key}>
                  <Link
                    to="/tickets/$key"
                    params={{ key: t.key }}
                    search={search}
                    data-ticket={t.key}
                    aria-current={t.key === picked ? "page" : undefined}
                    className={cn(
                      "flex flex-col gap-2 rounded-md border bg-panel px-3 py-2.5 shadow-[var(--shadow-1)] hover:bg-[var(--hover)]",
                      t.key === picked ? "border-primary" : "border-line",
                    )}
                  >
                    <span className="flex items-center gap-2 text-[12px] text-ink-2">
                      <TypeIcon type={t.issuetype} />
                      <span className="font-mono">{t.key}</span>
                      {g.statuses.length > 1 && <JiraStatus status={t.status} />}
                      <span className="ml-auto">
                        <Estimate points={t.points} size={t.size} />
                      </span>
                    </span>
                    <span className="line-clamp-3 leading-snug">{t.summary}</span>
                    <span className="flex items-center justify-between gap-2 border-t border-line pt-2 text-[12px]">
                      {facts.isMine(t) ? (
                        <span />
                      ) : (
                        <span className="flex min-w-0 items-center gap-1.5 text-ink-2">
                          {t.assignee ? (
                            <>
                              <Avatar name={t.assignee.displayName} />
                              <span className="truncate">{t.assignee.displayName}</span>
                            </>
                          ) : (
                            <span>Sin asignar</span>
                          )}
                        </span>
                      )}
                      <span
                        className={cn("min-w-0 truncate", fact.warn ? "text-warn" : "text-ink-2")}
                        title={fact.title}
                      >
                        {fact.text}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
