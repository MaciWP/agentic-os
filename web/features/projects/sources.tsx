import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Icon } from "../../icons.tsx";
import { DisabledState, ErrorState, errorText, InlineError, isOff } from "../../ui.tsx";
import { usePalette } from "../palette/palette.tsx";
import { PR_GROUPS, ReviewButton, usePullRequests } from "../prs/panel.tsx";
import {
  type BringItem,
  type BringMode,
  bringLabel,
  startBring,
  useBringMode,
  withMode,
} from "../terminals/bring.ts";
import { groupByStatus, type TicketRow } from "../tickets/groups.ts";
import { TypeIcon } from "../tickets/icons.tsx";
import { useTeamTickets, useTickets } from "../tickets/queries.ts";
import { TicketEnv } from "./ticket-env.tsx";

// Tickets and PRs in the rail's tabs, as thin rows dragged onto a Mesa tile; «Copiar contexto»
// takes one anywhere else. Every read that fails says so in place.

// An explicit list: Release Ready is also in Jira's "indeterminate" category.
const REVIEW_STATES = new Set(["En curso", "Pull Request", "In Product Review"]);

// My open tickets, and teammates' assigned ones in progress or review, each once.
export function useSourceTickets() {
  const q = useTickets();
  const team = useTeamTickets();
  const own = q.data && !isOff(q.data) ? q.data.tickets : [];
  const mine = new Set(own.map((t) => t.key));
  const teamData = !team.isError && team.data && !isOff(team.data) ? team.data : undefined;
  const others =
    teamData?.tickets.filter(
      (t) =>
        !mine.has(t.key) &&
        t.assignee &&
        t.assignee.accountId !== teamData.me &&
        REVIEW_STATES.has(t.status.name),
    ) ?? [];
  const tickets = [...new Map([...own, ...others].map((t) => [t.key, t])).values()];
  return { q, team, mine, tickets };
}

const MODES: { id: BringMode; title: string; hint: string }[] = [
  {
    id: "content",
    title: "Solo contenido",
    hint: "Un agente recibe el ticket o la PR entera con sus comentarios, sin ninguna orden; la instrucción la escribes tú",
  },
  {
    id: "task",
    title: "Con tarea",
    hint: "Un agente recibe el contenido y la tarea: Trabajar en los tuyos, Revisar los de compañeros y las PR",
  },
];

// What a dragged row brings to an agent; kept in this browser for the palette too.
function BringModeSwitch({ mode, onMode }: { mode: BringMode; onMode: (m: BringMode) => void }) {
  return (
    <fieldset
      aria-label="Qué lleva una fila a un agente"
      className="flex min-w-0 flex-wrap items-center gap-0.5 px-4 pb-1 text-[11px]"
    >
      <span className="mr-1 text-ink-2">Al arrastrar:</span>
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          className="nav-item text-[11px]"
          aria-pressed={mode === m.id}
          title={m.hint}
          onClick={() => onMode(m.id)}
        >
          {m.title}
        </button>
      ))}
    </fieldset>
  );
}

// One thin row: dragged, it carries only its item; its commands show on hover or focus.
function SourceRow({
  item,
  copy,
  children,
  actions,
}: {
  item: BringItem;
  copy: { ticket: string } | { pr: { repo: string; number: number } };
  children: ReactNode;
  actions?: ReactNode;
}) {
  const palette = usePalette();
  return (
    <li
      draggable
      onPointerDown={() => window.getSelection()?.removeAllRanges()}
      onDragStart={startBring(item)}
      title={`Arrastra ${bringLabel(item)} a una terminal de la mesa`}
      className="group/src flex min-h-7 min-w-0 cursor-grab flex-wrap items-center gap-x-1 rounded px-1 hover:bg-[var(--hover)] active:cursor-grabbing"
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px]">{children}</span>
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-focus-within/src:opacity-100 group-hover/src:opacity-100 [@media(hover:none)]:opacity-100">
        {actions}
        <button
          type="button"
          className="btn-ghost px-1"
          aria-label={`Copiar contexto de ${bringLabel(copy)}`}
          title="Copiar contexto: el texto entero, para pegarlo donde quieras"
          onClick={() => palette?.copy(copy)}
        >
          <Icon name="copy" size={13} />
        </button>
      </span>
    </li>
  );
}

const TicketLine = ({ t, mine }: { t: TicketRow; mine: boolean }) => (
  <Link
    to="/tickets/$key"
    params={{ key: t.key }}
    search={mine ? {} : { w: "all" }}
    draggable={false}
    className="flex min-w-0 flex-1 items-center gap-1.5 text-ink hover:underline"
    title={`${t.key}: ${t.summary}\n${t.status.name} · ${t.assignee?.displayName ?? "Sin asignar"}`}
  >
    <TypeIcon type={t.issuetype} />
    <span className="shrink-0 font-mono text-ink-2">{t.key}</span>
    <span className="min-w-0 truncate">{t.summary}</span>
    {!mine && <span className="pill shrink-0 bg-primary/10 text-primary">Revisar</span>}
  </Link>
);

// My tickets and teammates' to review, by status: the rail's «Tickets» tab.
export function TicketsList() {
  const { q, team, mine, tickets } = useSourceTickets();
  const [mode, setMode] = useBringMode();
  if (q.isPending)
    return (
      <p role="status" className="px-4 py-2 text-[12px] text-ink-2">
        Cargando tickets…
      </p>
    );
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (isOff(q.data)) return <DisabledState provider="Jira" />;
  return (
    <>
      <BringModeSwitch mode={mode} onMode={setMode} />
      {team.isPending ? (
        <p role="status" className="px-4 py-1 text-[12px] text-ink-2">
          Cargando tickets del equipo…
        </p>
      ) : team.isError ? (
        <InlineError as="div" className="px-4 py-1 text-[12px]">
          Sin tickets del equipo: {errorText(team.error)}{" "}
          <button type="button" className="btn-ghost" onClick={() => team.refresh()}>
            Reintentar
          </button>
        </InlineError>
      ) : (
        !isOff(team.data) &&
        tickets.length === 0 && (
          <p className="px-4 py-2 text-[12px] text-ink-2">
            No hay tickets propios abiertos ni de compañeros en proceso o revisión.
          </p>
        )
      )}
      <ul className="px-2 pb-2">
        {groupByStatus(tickets).flatMap((g) =>
          g.tickets.map((t) => (
            <SourceRow
              key={t.key}
              item={withMode({ ticket: t.key }, mode, mine.has(t.key))}
              copy={{ ticket: t.key }}
              actions={<TicketEnv ticket={t.key} />}
            >
              <TicketLine t={t} mine={mine.has(t.key)} />
            </SourceRow>
          )),
        )}
      </ul>
    </>
  );
}

// The open PRs of these repos, in PR_GROUPS order: to review, mine, the rest.
export function usePrRows(repos: string[]) {
  const q = usePullRequests();
  const read = q.data && !isOff(q.data) ? q.data : undefined;
  const prs = read
    ? PR_GROUPS.flatMap(({ kind }) =>
        read.prs.filter((p) => p.kind === kind && repos.includes(p.repo)),
      )
    : [];
  return { q, prs, errors: read?.errors ?? [] };
}

// The rail's «PRs» tab: the open PRs of these repos.
export function PrsList({ repos }: { repos: string[] }) {
  const { q, prs, errors } = usePrRows(repos);
  const [mode] = useBringMode();
  if (q.data && isOff(q.data)) return <DisabledState provider="GitHub" />;
  return (
    <>
      {q.isPending ? (
        <p role="status" className="px-4 py-2 text-[12px] text-ink-2">
          Cargando PR…
        </p>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          {errors.map((e) => (
            <InlineError key={e} className="px-4 pt-1 text-[12px]">
              {e}
            </InlineError>
          ))}
          {prs.length === 0 && errors.length === 0 && (
            <p className="px-4 py-2 text-[12px] text-ink-2">No hay PR abiertas en tus repos.</p>
          )}
          <ul className="px-2 pb-2">
            {prs.map((pr) => (
              <SourceRow
                key={`${pr.repo}#${pr.number}`}
                item={withMode({ pr: { repo: pr.repo, number: pr.number } }, mode)}
                copy={{ pr: { repo: pr.repo, number: pr.number } }}
                actions={<ReviewButton pr={pr} className="btn-ghost px-1 text-[11px]" />}
              >
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noreferrer"
                  draggable={false}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-ink hover:underline"
                  title={`${pr.repo}#${pr.number}: ${pr.title}\n${pr.author}`}
                >
                  <Icon name="pr" size={12} />
                  <span className="shrink-0 font-mono text-ink-2">
                    {pr.repo}#{pr.number}
                  </span>
                  <span className="min-w-0 truncate">{pr.title}</span>
                  {pr.kind === "review" && (
                    <span className="pill shrink-0 bg-primary/10 text-primary">Revisar</span>
                  )}
                  {pr.draft && <span className="pill shrink-0">Borrador</span>}
                </a>
              </SourceRow>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
