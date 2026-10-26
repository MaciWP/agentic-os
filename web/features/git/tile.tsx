import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Icon } from "../../icons.tsx";
import { ErrorState, InlineError, SkeletonRows, StaleNotice } from "../../ui.tsx";
import { findNode, useProjects } from "../projects/queries.ts";
import { TERM_ICON } from "../terminals/panel.tsx";
import { type HeaderDrag, TileHeader } from "../terminals/tile-header.tsx";
import { type Pick, picks, resolvePick } from "./changes.ts";
import { type DiffMode, DiffView, storedMode } from "./diff-view.tsx";
import { type GitStatus, gitErrorText, useGitAction, useGitStatus } from "./queries.ts";
import { SourceControl } from "./source-control.tsx";

const typing = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

const pickKey = (p: Pick) => `${p.staged ? "s" : "w"}:${p.path}`;

// j/k move between files, n/p between the hunks of the open diff, s stages or takes back the
// open file. Only while the focus is in this tile, never while typing, never with a modifier:
// each git tile answers its own keys and the browser keeps its own.
function useKeys(
  root: React.RefObject<HTMLDivElement | null>,
  s: GitStatus | undefined,
  pick: Pick | null,
  onPick: (p: Pick) => void,
  act: ReturnType<typeof useGitAction>,
) {
  // The hunk n/p reached, for the file it was reached in; another file starts from its top.
  const hunk = useRef({ file: "", at: -1 });
  return (e: KeyboardEvent<HTMLDivElement>) => {
    if (
      !s ||
      e.metaKey ||
      e.ctrlKey ||
      e.altKey ||
      typing(e.target) ||
      document.querySelector("dialog[open]")
    )
      return;
    const all = picks(s);
    const at = all.findIndex((p) => p.path === pick?.path && p.staged === pick.staged);
    if (e.key === "j" || e.key === "k") {
      const next = all[Math.max(0, Math.min(all.length - 1, at + (e.key === "j" ? 1 : -1)))];
      if (!next) return;
      onPick(next);
      root.current
        ?.querySelector(`[data-pick="${CSS.escape(pickKey(next))}"]`)
        ?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "n" || e.key === "p") {
      const rows = root.current?.querySelectorAll<HTMLElement>("[data-diff-scroll] [data-hunk]");
      if (!rows || rows.length === 0) return;
      const here = pick ? pickKey(pick) : "";
      if (hunk.current.file !== here) hunk.current = { file: here, at: -1 };
      hunk.current.at = Math.max(
        0,
        Math.min(rows.length - 1, hunk.current.at + (e.key === "n" ? 1 : -1)),
      );
      rows[hunk.current.at]?.scrollIntoView({ block: "start" });
    } else if (e.key === "s" && pick && !act.isPending) {
      const file = s.files.find((f) => f.path === pick.path);
      if (!file || file.kind === "conflict") return;
      act.mutate({ op: pick.staged ? "unstage" : "stage", paths: [pick.path] });
    } else return;
    e.preventDefault();
  };
}

// A checkout's git as a Mesa tile, beside its terminals: a header like theirs (the tile's
// number, "Git", the checkout), then the source-control column and the picked file's diff
// side by side; a narrow tile shows one at a time. Agents edit without telling the app, so
// it reads the status and the diff again every few seconds while the page is visible.
export function GitView({
  location,
  lead,
  actions,
  drag,
}: {
  location: string | null;
  lead?: ReactNode;
  actions?: ReactNode;
  drag?: HeaderDrag;
}) {
  const root = useRef<HTMLDivElement>(null);
  const status = useGitStatus(location ?? "", true);
  const projects = useProjects();
  const act = useGitAction(location ?? "");
  const [picked, setPicked] = useState<Pick | null>(null);
  // A narrow tile shows the diff once a file is picked; "Ficheros" goes back to the list.
  const [reading, setReading] = useState(false);
  const [mode, setMode] = useState<DiffMode>(storedMode);
  const label = (location && projects.data && findNode(projects.data, location)?.label) || location;
  const s = status.data?.repo ? status.data : undefined;
  const pick = s ? resolvePick(s, picked) : null;
  const choose = (p: Pick) => {
    setPicked(p);
    setReading(true);
  };
  const onKey = useKeys(root, s, pick, choose, act);
  // A picked file that left the list leaves nothing to read.
  const none = pick === null;
  useEffect(() => {
    if (none) setReading(false);
  }, [none]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the keys of the tile's own list and diff
    <div
      ref={root}
      tabIndex={-1}
      onKeyDown={onKey}
      className="@container flex h-full min-h-0 flex-col bg-panel text-ink outline-none"
    >
      <TileHeader
        lead={lead}
        harness="git"
        chip="Git"
        label={label}
        title={location ?? ""}
        drag={drag}
      >
        <span className="hidden text-white/45 @[40rem]:inline">
          j/k fichero · n/p hunk · s preparar
        </span>
        <button
          type="button"
          className={`${TERM_ICON} disabled:opacity-40`}
          aria-label="Actualizar"
          title="Leer el estado de git otra vez"
          disabled={!location || status.isFetching}
          onClick={() => void status.refetch()}
        >
          <Icon name="refresh" size={14} />
        </button>
        {actions}
      </TileHeader>
      {!location ? (
        <p className="px-4 py-3 text-[12px] text-ink-2">
          Esta tile no dice de qué checkout es: quítala y ábrela otra vez desde un proyecto.
        </p>
      ) : status.isPending ? (
        <SkeletonRows count={4} />
      ) : status.isError && !status.data ? (
        <ErrorState error={status.error} onRetry={() => status.refetch()} />
      ) : !s ? (
        <p className="px-4 py-3 text-[12px] text-ink-2">
          No es un repo de git: aquí no hay estado que mostrar.
        </p>
      ) : (
        <>
          {/* A failed poll keeps the tile, and the commit message being written in it. */}
          {status.isError && (
            <StaleNotice
              error={status.error}
              onRetry={() => status.refetch()}
              className="mx-3 mt-2"
            />
          )}
          <div className="flex min-h-0 flex-1 @[44rem]:grid @[44rem]:grid-cols-[minmax(240px,320px)_minmax(0,1fr)]">
            <aside
              aria-label={`Control de versiones de ${label}`}
              className={`min-h-0 min-w-0 flex-1 border-line bg-panel @[44rem]:block @[44rem]:border-r ${
                reading ? "hidden" : "block"
              }`}
            >
              <SourceControl location={location} s={s} pick={pick} onPick={choose} />
            </aside>
            <main
              className={`min-h-0 min-w-0 flex-1 flex-col bg-bg @[44rem]:flex ${
                reading ? "flex" : "hidden"
              }`}
            >
              <button
                type="button"
                className="btn-ghost m-1 self-start gap-1 @[44rem]:hidden"
                onClick={() => setReading(false)}
              >
                <span className="inline-flex rotate-180">
                  <Icon name="chevron" size={12} />
                </span>
                Ficheros
              </button>
              {act.error && (
                <InlineError className="border-b border-line px-3 py-2 text-[12px]">
                  {gitErrorText(act.error)}
                </InlineError>
              )}
              {pick ? (
                <DiffView
                  key={pickKey(pick)}
                  location={location}
                  pick={pick}
                  file={s.files.find((f) => f.path === pick.path)}
                  mode={mode}
                  onMode={setMode}
                  poll
                />
              ) : (
                <p className="px-4 py-3 text-[12px] text-ink-2">
                  Sin cambios: el árbol de trabajo está limpio.
                </p>
              )}
            </main>
          </div>
        </>
      )}
    </div>
  );
}
