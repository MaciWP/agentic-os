import { Link, useParams, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ticketBranch } from "../../../shared/envs.ts";
import { PageBar } from "../../page-bar.tsx";
import {
  DisabledState,
  ErrorState,
  errorText,
  InlineError,
  isOff,
  SkeletonRows,
  StaleNotice,
} from "../../ui.tsx";
import { keyIn } from "../home/join.ts";
import { KickoffButton, useKickoffs } from "../kickoff/kickoff.tsx";
import { ticketEnv, useProjects } from "../projects/queries.ts";
import { TicketEnv } from "../projects/ticket-env.tsx";
import { usePullRequests } from "../prs/panel.tsx";
import {
  Board,
  type BoardFacts,
  BoardSwitch,
  shownBy,
  type TeamRead,
  type TicketsSearch,
  WhoFilter,
} from "./board.tsx";
import { TicketDetail } from "./detail.tsx";
import type { TicketRow } from "./groups.ts";
import { useBoard, useTickets } from "./queries.ts";
import { Review } from "./review.tsx";

const SECTION = "section-title";

// Flujo: one Jira board as Jira shows it (data/config.json copies its columns), the first
// board by default. The user's own tickets on it by default, the whole team's or one person's
// on demand. A ticket opens in a panel beside the board: a teammate's can be taken for review
// there, and any can get its env and an agent.
export function TicketsPage() {
  const { key } = useParams({ strict: false });
  const search = useSearch({ strict: false }) as TicketsSearch;
  const { w: who, b } = search;
  const mine = useTickets();
  const board = useBoard(b);
  const prs = usePullRequests();
  const projects = useProjects();
  const kickoffs = useKickoffs();

  const mineList = mine.data && !isOff(mine.data) ? mine.data.tickets : undefined;
  const boardData = board.data && !isOff(board.data) ? board.data : undefined;
  const me = boardData?.me ?? null;
  // The boards to switch between, kept while another board loads.
  const [boards, setBoards] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (boardData) setBoards(boardData.boards);
  }, [boardData]);
  const mineKeys = new Set(mineList?.map((t) => t.key));
  const isMine = (t: Pick<TicketRow, "key" | "assignee">) =>
    mineKeys.has(t.key) || (me !== null && t.assignee?.accountId === me);
  const prList = prs.data && !isOff(prs.data) ? prs.data.prs : [];
  const facts: BoardFacts = {
    isMine,
    prsOf: (k) => prList.filter((p) => keyIn(p.title, [k]) !== null),
    envOf: (k) => {
      const env = projects.data ? ticketEnv(projects.data, k) : undefined;
      return typeof env === "object" ? env.name : null;
    },
    kickoffOf: (k) => kickoffs.data?.kickoffs.find((x) => x.key === k),
  };
  const teamRead: TeamRead = board.isPending
    ? { state: "loading" }
    : boardData
      ? { state: "ok", tickets: boardData.tickets, isMine }
      : { state: "off" };
  // The board's tickets through the filter: the user's own, or whoever's the filter names.
  const shown = boardData?.tickets.filter((t) => (who === undefined ? isMine(t) : shownBy(who, t)));
  const boardName = boardData?.board.name;
  const prProblems = prs.isError
    ? [errorText(prs.error)]
    : prs.data && !isOff(prs.data)
      ? prs.data.errors
      : [];
  // Why the PR list may be short ("loading", "off" or GitHub's error); «Revisar yo» must not read a gap as "no PRs".
  const prGap = prs.isPending
    ? "loading"
    : prProblems.length > 0
      ? prProblems.join(" · ")
      : prs.data && isOff(prs.data)
        ? "off"
        : null;

  const subtitle = boardName ? `tablero «${boardName}» de Jira` : "abiertos, por estado de Jira";
  return (
    <div className="flex min-h-0 flex-1">
      <div className={`min-h-0 min-w-0 flex-1 flex-col ${key ? "hidden md:flex" : "flex"}`}>
        <PageBar>
          <h1 className="font-semibold">Tickets</h1>
          <p className="min-w-0 flex-1 basis-0 truncate text-[12px] text-ink-2" title={subtitle}>
            {subtitle}
          </p>
          <button
            type="button"
            className="btn ml-auto"
            onClick={() => {
              void mine.refresh();
              void board.refresh();
            }}
            disabled={mine.isFetching || board.isFetching}
          >
            {mine.isFetching || board.isFetching ? "Cargando…" : "Recargar"}
          </button>
        </PageBar>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
          <BoardSwitch
            boards={boardData?.boards ?? boards}
            shown={boardData?.board.id ?? b ?? boards[0]?.id}
            who={who}
            ticketKey={key}
          />
          <WhoFilter
            who={who}
            board={b}
            mine={boardData ? boardData.tickets.filter(isMine).length : null}
            team={teamRead}
            ticketKey={key}
          />
          {mine.isError && (
            <StaleNotice error={mine.error} onRetry={() => void mine.refresh()}>
              No se pudo leer tu lista de Jira; «Míos» se marca solo por el asignado del tablero
            </StaleNotice>
          )}
          {prProblems.length > 0 && (
            <InlineError className="text-[12px]">
              Sin PRs de GitHub en las tarjetas: {prProblems.join(" · ")}
            </InlineError>
          )}
          {board.isPending ? (
            <SkeletonRows />
          ) : board.isError ? (
            <ErrorState error={board.error} onRetry={() => board.refresh()} />
          ) : isOff(board.data) ? (
            <DisabledState provider="Jira" />
          ) : !shown || shown.length === 0 ? (
            <p className="text-ink-2">
              {who === undefined
                ? `No tienes tickets abiertos en «${boardName}».`
                : `Nadie tiene tickets abiertos en «${boardName}» con este filtro.`}
            </p>
          ) : (
            <Board
              tickets={shown}
              columns={boardData?.board.columns ?? null}
              picked={key}
              search={search}
              facts={facts}
            />
          )}
        </div>
      </div>
      {key && (
        <aside
          aria-label="Ticket"
          className="flex min-h-0 w-full flex-col overflow-y-auto bg-panel md:w-[480px] md:shrink-0 md:border-l md:border-line"
        >
          <div className="hidden justify-end px-3 pt-3 md:flex">
            <Link to="/tickets" search={search} className="btn-ghost">
              Cerrar
            </Link>
          </div>
          <TicketDetail
            key={key}
            ticketKey={key}
            extra={(t) => (
              <div className="mt-6 flex flex-col gap-6">
                {(isMine(t) || !t.assignee) && projects.data?.envs.configured && (
                  <section aria-labelledby="kickoff-title" className="flex flex-col gap-2.5">
                    <h2 id="kickoff-title" className={SECTION}>
                      Arranque
                    </h2>
                    <KickoffButton ticketKey={t.key} mode="start" />
                  </section>
                )}
                {!isMine(t) && (
                  <section aria-labelledby="review-title" className="flex flex-col gap-2.5">
                    <h2 id="review-title" className={SECTION}>
                      Revisión
                    </h2>
                    <Review key={t.key} t={t} me={me} prs={facts.prsOf(t.key)} prGap={prGap} />
                    {projects.data?.envs.configured &&
                      facts.prsOf(t.key).some((p) => p.kind !== "mine") && (
                        <KickoffButton
                          key={t.key}
                          ticketKey={t.key}
                          mode="review"
                          pulls={facts.prsOf(t.key).filter((p) => p.kind !== "mine")}
                        />
                      )}
                  </section>
                )}
                {projects.data?.envs.configured && (
                  <section aria-labelledby="env-title" className="flex flex-col gap-1.5">
                    <h2 id="env-title" className={SECTION}>
                      Entorno
                    </h2>
                    {ticketEnv(projects.data, t.key) === undefined && (
                      <p className="text-[12px] text-ink-2">
                        Ninguno trabaja este ticket. «Crear entorno» crea{" "}
                        <span className="font-mono text-ink">{t.key.toLowerCase()}</span> en la rama{" "}
                        <span className="font-mono text-ink">{ticketBranch(t.key)}</span> y lo abre
                        en la Mesa.
                      </p>
                    )}
                    <TicketEnv ticket={t.key} />
                  </section>
                )}
              </div>
            )}
          />
        </aside>
      )}
    </div>
  );
}
