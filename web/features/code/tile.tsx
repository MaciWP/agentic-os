import { useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Icon } from "../../icons.tsx";
import { errorText, InlineError } from "../../ui.tsx";
import { findNode, useProjects } from "../projects/queries.ts";
import { TERM_ICON } from "../terminals/panel.tsx";
import { type HeaderDrag, TileHeader } from "../terminals/tile-header.tsx";
import { FileView } from "./file-view.tsx";
import { ancestors } from "./nav.ts";
import { openIn, type Target, useTarget } from "./open.ts";
import { codeDefinitionQuery, type Definition, useCodeFile } from "./queries.ts";
import { QuickOpen } from "./quick-open.tsx";
import { CodeTree } from "./tree.tsx";

type Lookup =
  | { name: string; state: "pending" }
  | { name: string; state: "found"; hits: Definition[] }
  | { name: string; state: "failed"; error: unknown };

// A checkout's code as a Mesa tile, beside its terminals and its git: the header like
// theirs, then the folders and the open file side by side; a narrow tile shows one at a
// time. ⌘P finds a file, ⌘/Ctrl+click on a name goes to its definition, ⌃- comes back (VS
// Code's key: ⌥← moves a word in the editor). The open file is read again every few seconds:
// agents edit behind the app.
export function CodeView({
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
  const client = useQueryClient();
  const projects = useProjects();
  const target = useTarget(location ?? "");
  const file = useCodeFile(location ?? "", target?.path ?? "");
  const [open, setOpen] = useState<Set<string>>(() => new Set(ancestors(target?.path ?? "")));
  // A narrow tile shows the file once one is picked; "Ficheros" goes back to the tree.
  const [reading, setReading] = useState(target !== null);
  const [quick, setQuick] = useState(false);
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const history = useRef<Target[]>([]);
  const label = (location && projects.data && findNode(projects.data, location)?.label) || location;

  const go = (path: string, line: number | null = null, remember = true) => {
    if (!location) return;
    if (remember && target) history.current = [...history.current.slice(-49), target];
    openIn(location, path, line);
    setLookup(null);
  };
  // Whoever opened the file (this tile, or the git diff's "Abrir en Código"), its folders
  // unfold and a narrow tile turns to it.
  const seq = target?.seq ?? 0;
  const opened = target?.path ?? "";
  // Each open mounts the file anew: focus that was in the old one would fall to the page and
  // leave the tile deaf to ⌃- and ⌘P, so it comes back to the tile.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (seq === 0) return;
    setOpen((o) => new Set([...o, ...ancestors(opened)]));
    setReading(true);
    if (document.activeElement === document.body) root.current?.focus({ preventScroll: true });
  }, [seq, opened]);
  const back = () => {
    const prev = history.current.pop();
    if (prev) go(prev.path, prev.line, false);
  };
  const define = (name: string) => {
    if (!location || !target) return;
    setLookup({ name, state: "pending" });
    client.fetchQuery({ ...codeDefinitionQuery(location, target.path, name), staleTime: 0 }).then(
      ({ hits }) => {
        const only = hits.length === 1 ? hits[0] : undefined;
        if (only) go(only.path, only.line);
        else setLookup({ name, state: "found", hits });
      },
      (error: unknown) => setLookup({ name, state: "failed", error }),
    );
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      setQuick(true);
    } else if (e.ctrlKey && !e.metaKey && e.key === "-" && history.current.length > 0) {
      e.preventDefault();
      back();
    } else if (e.key === "Escape" && lookup) {
      setLookup(null);
    }
  };
  const toggle = (dir: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (!next.delete(dir)) next.add(dir);
      return next;
    });
  const path = target?.path ?? "";

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the tile's own shortcuts (⌘P, ⌃-)
    <div
      ref={root}
      tabIndex={-1}
      onKeyDown={onKey}
      className="@container relative flex h-full min-h-0 flex-col bg-panel text-ink outline-none"
    >
      <TileHeader
        lead={lead}
        harness="code"
        chip="Código"
        label={label}
        title={location ?? ""}
        drag={drag}
      >
        <span className="hidden text-white/45 @[40rem]:inline">
          ⌘P abrir · ⌘clic definición · ⌃- volver
        </span>
        <button
          type="button"
          className={TERM_ICON}
          aria-label="Abrir fichero"
          title="Abrir un fichero por su nombre (⌘P)"
          disabled={!location}
          onClick={() => setQuick(true)}
        >
          <Icon name="search" size={14} />
        </button>
        <button
          type="button"
          className={TERM_ICON}
          aria-label="Actualizar"
          title="Leer las carpetas y el fichero otra vez"
          disabled={!location}
          onClick={() => void client.invalidateQueries({ queryKey: ["code"] })}
        >
          <Icon name="refresh" size={14} />
        </button>
        {actions}
      </TileHeader>
      {!location ? (
        <p className="px-4 py-3 text-[12px] text-ink-2">
          Esta tile no dice de qué checkout es: quítala y ábrela otra vez desde un proyecto.
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 @[44rem]:grid @[44rem]:grid-cols-[minmax(200px,280px)_minmax(0,1fr)]">
          {quick && (
            <QuickOpen
              location={location}
              onClose={() => setQuick(false)}
              onPick={(p) => {
                setQuick(false);
                go(p);
              }}
            />
          )}
          <aside
            aria-label={`Ficheros de ${label}`}
            className={`min-h-0 min-w-0 flex-1 border-line bg-panel @[44rem]:block @[44rem]:border-r ${
              reading ? "hidden" : "block"
            }`}
          >
            <CodeTree
              location={location}
              open={open}
              selected={target?.path ?? null}
              onToggle={toggle}
              onPick={(p) => go(p)}
            />
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
            {!target ? (
              <p className="px-4 py-3 text-[12px] text-ink-2">
                Elige un fichero en el árbol o pulsa ⌘P.
              </p>
            ) : (
              <FileView
                key={`${path}\0${target.seq}`}
                location={location}
                path={path}
                file={file}
                line={target.line}
                seq={target.seq}
                onWord={define}
                onOpen={(p) => go(p)}
                back={
                  <button
                    type="button"
                    className={`${TERM_ICON} disabled:opacity-40`}
                    aria-label="Volver"
                    title="Volver al sitio anterior (⌃-)"
                    disabled={history.current.length === 0}
                    onClick={back}
                  >
                    <span className="inline-flex rotate-180">
                      <Icon name="chevron" size={14} />
                    </span>
                  </button>
                }
              >
                {lookup && (
                  <section
                    aria-label={`Definiciones de ${lookup.name}`}
                    className="max-h-48 shrink-0 overflow-auto border-line border-b text-[12px]"
                  >
                    {lookup.state === "pending" ? (
                      <p className="px-3 py-2 text-ink-2">Buscando {lookup.name}…</p>
                    ) : lookup.state === "failed" ? (
                      <InlineError className="px-3 py-2">{errorText(lookup.error)}</InlineError>
                    ) : lookup.hits.length === 0 ? (
                      <p className="px-3 py-2 text-ink-2">
                        No encuentro dónde se define{" "}
                        <span className="font-mono">{lookup.name}</span>.
                      </p>
                    ) : (
                      <>
                        <p className="px-3 pt-2 text-ink-2">
                          {lookup.hits.length} sitios definen{" "}
                          <span className="font-mono">{lookup.name}</span>:
                        </p>
                        <ul className="py-1">
                          {lookup.hits.map((h) => (
                            <li key={`${h.path}:${h.line}`}>
                              <button
                                type="button"
                                className="flex w-full items-baseline gap-2 px-3 py-0.5 text-left font-mono hover:bg-[var(--hover)]"
                                onClick={() => go(h.path, h.line)}
                              >
                                <span className="shrink-0 text-ink">
                                  {h.path}:{h.line}
                                </span>
                                <span className="truncate text-ink-2">{h.text}</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </section>
                )}
              </FileView>
            )}
          </main>
        </div>
      )}
    </div>
  );
}
