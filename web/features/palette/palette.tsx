import { useNavigate } from "@tanstack/react-router";
import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Icon, type IconName } from "../../icons.tsx";
import { shortcut } from "../../keys.ts";
import { useActiveOption } from "../../listbox.ts";
import { isOff } from "../../ui.tsx";
import { useProjects } from "../projects/queries.ts";
import { usePullRequests } from "../prs/panel.tsx";
import {
  type BringItem,
  bringLabel,
  type Target,
  useBringMode,
  withMode,
} from "../terminals/bring.ts";
import { ContextDialog, type ContextItem } from "../terminals/context-dialog.tsx";
import { HarnessDot } from "../terminals/harness.tsx";
import { mesaSearch } from "../terminals/mesas.ts";
import { type TerminalInfo, useTerminals } from "../terminals/queries.ts";
import { useTickets } from "../tickets/queries.ts";
import { buildItems, matchItems, PAGES, type PaletteItem } from "./items.ts";

// What the Mesa lends the palette while it is open: its numbered tiles, the bring that types
// into one (and says how it went in the Mesa's own notice), and the open that adds a tile.
export type MesaBridge = {
  targets: Target[];
  bring: (id: string, item: BringItem) => void;
  open: (t: TerminalInfo) => void;
};

// What the open Mesa can do from the palette: rename it, close it, move it to a block.
export type MesaCommand = {
  key: string;
  label: string;
  hint?: string;
  icon: IconName;
  run: () => void;
};

// `copy` opens «Copiar contexto» for a ticket or a PR, from the palette or a projects row.
type Palette = {
  mesa: { current: MesaBridge | null };
  commands: { current: MesaCommand[] };
  show: () => void;
  copy: (item: ContextItem) => void;
};
const PaletteContext = createContext<Palette | null>(null);
export const usePalette = () => useContext(PaletteContext);

// The Mesa registers itself on every render and leaves on unmount. A ref, not state: the
// palette reads it only when it opens or picks, so the Mesa never re-renders the shell.
export function useMesaBridge(bridge: MesaBridge) {
  const palette = usePalette();
  useEffect(() => {
    if (palette) palette.mesa.current = bridge;
  });
  useEffect(
    () => () => {
      if (palette) palette.mesa.current = null;
    },
    [palette],
  );
}

// The Mesa list lends its commands the same way: on every render, gone on unmount.
export function useMesaCommands(commands: MesaCommand[]) {
  const palette = usePalette();
  useEffect(() => {
    if (palette) palette.commands.current = commands;
  });
  useEffect(
    () => () => {
      if (palette) palette.commands.current = [];
    },
    [palette],
  );
}

// ⌘K anywhere. Ctrl+K too, except inside a terminal, where it is the shell's kill-line.
const isShortcut = (e: globalThis.KeyboardEvent) => {
  if (e.key.toLowerCase() !== "k" || e.altKey || e.shiftKey) return false;
  const inTerminal =
    e.target instanceof Element && e.target.closest("[data-terminal-screen]") !== null;
  return e.metaKey || (e.ctrlKey && !inTerminal);
};

export function PaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [copying, setCopying] = useState<ContextItem | null>(null);
  const [palette] = useState<Palette>(() => ({
    mesa: { current: null },
    commands: { current: [] },
    show: () => setOpen(true),
    copy: setCopying,
  }));
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!isShortcut(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  return (
    <PaletteContext.Provider value={palette}>
      {children}
      {open && (
        <PaletteDialog
          mesaRef={palette.mesa}
          commands={palette.commands.current}
          onCopy={setCopying}
          onClose={() => setOpen(false)}
        />
      )}
      {copying && <ContextDialog item={copying} onClose={() => setCopying(null)} />}
    </PaletteContext.Provider>
  );
}

type Read<T> = { isPending: boolean; isError: boolean; data?: T };

// Why the list may be short, so a missing terminal, project, ticket or PR never reads as
// "nothing matches".
export function sourceNotes(
  tickets: Read<object>,
  prs: Read<{ errors: string[] } | { disabled: true }>,
  own: { terminals: Read<object>; projects: Read<object> },
): string[] {
  const prErrors = prs.data && !isOff(prs.data) ? prs.data.errors : [];
  return [
    own.terminals.isPending && "Cargando terminales…",
    own.terminals.isError && "No se leyeron las terminales: no salen.",
    own.projects.isPending && "Cargando proyectos…",
    own.projects.isError && "No se leyeron los proyectos: no salen.",
    tickets.isPending && "Cargando tickets…",
    tickets.isError && "Jira no responde: sin tickets.",
    tickets.data && isOff(tickets.data) && "Jira sin conectar: sin tickets.",
    prs.isPending && "Cargando PR…",
    prs.isError && "GitHub no responde: sin PR.",
    prs.data && isOff(prs.data) && "GitHub sin conectar: sin PR.",
    prErrors.length > 0 && `GitHub incompleto: ${prErrors.join(" · ")}`,
  ].filter((n): n is string => typeof n === "string");
}

export function PaletteButton() {
  const palette = usePalette();
  return (
    <button
      type="button"
      className="btn-ghost ml-auto size-7 justify-center"
      aria-label="Buscar"
      aria-keyshortcuts="Meta+K Control+K"
      title={`Buscar (${shortcut("K")})`}
      onClick={() => palette?.show()}
    >
      <Icon name="search" />
    </button>
  );
}

// One row of the list. `run` is absent on a disabled row, whose `hint` says why.
type Row = {
  key: string;
  group: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  disabled?: boolean;
  run?: () => void;
};

const bringItem = (it: PaletteItem): ContextItem | null =>
  it.action.go === "ticket"
    ? { ticket: it.action.key }
    : it.action.go === "pr"
      ? { pr: { repo: it.action.repo, number: it.action.number } }
      : null;

// Read only while open: the terminals come with the shell's own stream, the rest from the
// server's caches, so a closed palette costs no request. A ticket or a PR opens a second step:
// a Mesa tile to bring it to, «Copiar contexto», or open it.
// ponytail: no launching from the palette (harness × location is a dialog of its own, and the
// tree's "+" already does it); add it when launching from the keyboard is asked for.
function PaletteDialog({
  mesaRef,
  commands,
  onCopy,
  onClose,
}: {
  mesaRef: Palette["mesa"];
  commands: MesaCommand[];
  onCopy: (item: ContextItem) => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const mesa = mesaRef.current;
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [bringing, setBringing] = useState<PaletteItem | null>(null);
  const terminalsRead = useTerminals();
  const terminals = terminalsRead.data?.terminals ?? [];
  const projects = useProjects();
  const tickets = useTickets();
  const prs = usePullRequests();
  // The same choice as the Mesa's rail: content alone, or with the task.
  const [bringMode] = useBringMode();

  useEffect(() => {
    const back = document.activeElement;
    dialog.current?.showModal();
    return () => {
      if (back instanceof HTMLElement) back.focus();
    };
  }, []);

  const go = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const toRow = (it: PaletteItem): Row => {
    const a = it.action;
    const base = { key: it.key, group: it.group, label: it.label, hint: it.hint };
    switch (a.go) {
      case "page":
        return {
          ...base,
          icon: <Icon name={PAGES.find((p) => p.to === a.to)?.icon ?? "home"} />,
          run: go(() => void navigate({ to: a.to })),
        };
      case "terminal": {
        const t = terminals.find((x) => x.id === a.id);
        return {
          ...base,
          icon: t ? <HarnessDot kind={t.harness} /> : null,
          ...(!t
            ? { disabled: true, hint: it.hint }
            : {
                run: go(() =>
                  mesa
                    ? mesa.open(t)
                    : void navigate({ to: "/terminales", search: mesaSearch({ t: t.id }) }),
                ),
              }),
        };
      }
      case "command": {
        const c = commands.find((x) => x.key === a.key);
        return {
          ...base,
          icon: <Icon name={c?.icon ?? "mesa"} />,
          ...(c ? { run: go(c.run) } : { disabled: true }),
        };
      }
      case "node":
        return {
          ...base,
          icon: <Icon name="folder" />,
          run: go(() => void navigate({ to: "/terminales", search: mesaSearch({ node: a.node }) })),
        };
      default: {
        const item = bringItem(it);
        return {
          ...base,
          icon: <Icon name={a.go === "pr" ? "pr" : "ticket"} />,
          run: item
            ? () => {
                setBringing(it);
                setActive(0);
              }
            : go(() => openItem(it)),
        };
      }
    }
  };
  const openItem = (it: PaletteItem) => {
    const a = it.action;
    if (a.go === "ticket") void navigate({ to: "/tickets/$key", params: { key: a.key } });
    if (a.go === "pr") window.open(a.url, "_blank", "noopener");
  };

  const what = bringing && bringItem(bringing);
  const whatLabel = what ? bringLabel(what) : "";
  const rows: Row[] =
    bringing && what
      ? [
          ...(mesa?.targets ?? []).map(
            (t): Row => ({
              key: t.id,
              group: `Llevar ${whatLabel} a…`,
              label: t.name,
              icon: <span className="tile-num">{t.n}</span>,
              ...(t.blocked
                ? { disabled: true, hint: t.blocked }
                : { run: go(() => mesa?.bring(t.id, withMode(what, bringMode))) }),
            }),
          ),
          {
            key: "copy",
            group: "O bien",
            label: "Copiar contexto",
            hint: "Para pegarlo donde quieras",
            icon: <Icon name="copy" />,
            run: go(() => onCopy(what)),
          },
          {
            key: "open",
            group: "O bien",
            label: bringing.action.go === "pr" ? "Abrir la PR en GitHub" : "Abrir el ticket",
            icon: <Icon name={bringing.action.go === "pr" ? "external" : "ticket"} />,
            run: go(() => openItem(bringing)),
          },
        ]
      : matchItems(
          buildItems({
            terminals,
            projects: projects.data,
            tickets: tickets.data && !isOff(tickets.data) ? tickets.data.tickets : undefined,
            prs: prs.data && !isOff(prs.data) ? prs.data.prs : undefined,
            commands,
          }),
          query,
        ).map(toRow);
  const {
    at,
    activeId,
    optionId,
    setActive,
    onKeyDown: moveOrChoose,
  } = useActiveOption(rows.length, "palette-opt");

  const notes = bringing ? [] : sourceNotes(tickets, prs, { terminals: terminalsRead, projects });

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) =>
    moveOrChoose(e, (i) => rows[i]?.run?.());

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a click on the backdrop closes; Esc is the dialog's own.
    <dialog
      ref={dialog}
      aria-label={
        bringing
          ? mesa
            ? `Llevar ${whatLabel} a una terminal`
            : `Qué hacer con ${whatLabel}`
          : "Buscar"
      }
      className="palette"
      onClose={onClose}
      onCancel={(e) => {
        // Esc in the second step goes back to the search, not out of the palette.
        if (!bringing) return;
        e.preventDefault();
        setBringing(null);
        setActive(0);
        input.current?.focus();
      }}
      onClick={(e) => e.target === dialog.current && dialog.current?.close()}
    >
      <div className="flex items-center gap-2 border-b border-line px-3">
        <Icon name="search" />
        <input
          ref={input}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-label={
            bringing
              ? mesa
                ? "Elige la terminal"
                : "Elige qué hacer"
              : "Buscar páginas, terminales, proyectos, tickets o PR"
          }
          placeholder={
            bringing
              ? `${mesa ? `Llevar ${whatLabel} a…` : whatLabel} (Esc vuelve)`
              : "Ir a una página, terminal, proyecto, ticket o PR…"
          }
          className="h-11 min-w-0 flex-1 bg-transparent text-[14px] outline-none"
          value={bringing ? "" : query}
          readOnly={Boolean(bringing)}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div id="palette-list" role="listbox" aria-label="Resultados" className="option-list">
        {rows.map((r, i) => (
          <PaletteRow
            key={r.key}
            row={r}
            id={optionId(i)}
            head={i === 0 || rows[i - 1]?.group !== r.group}
            selected={i === at}
            onHover={() => setActive(i)}
          />
        ))}
        {rows.length === 0 && (
          <div role="presentation" className="px-3 py-3 text-[12px] text-ink-2">
            Nada coincide con «{query}».
          </div>
        )}
      </div>
      <p className="flex flex-wrap gap-x-3 border-t border-line px-3 py-1.5 text-[11px] text-ink-2">
        {notes.map((n) => (
          <span key={n}>{n}</span>
        ))}
        <span className="ml-auto">
          ↑↓ moverse · Enter elegir · Esc {bringing ? "volver" : "cerrar"}
        </span>
      </p>
    </dialog>
  );
}

function PaletteRow({
  row,
  id,
  head,
  selected,
  onHover,
}: {
  row: Row;
  id: string;
  head: boolean;
  selected: boolean;
  onHover: () => void;
}) {
  return (
    <>
      {head && (
        <div role="presentation" aria-hidden className="option-head">
          {row.group}
        </div>
      )}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: keys reach the row through the combobox. */}
      <div
        id={id}
        role="option"
        tabIndex={-1}
        aria-selected={selected}
        aria-disabled={row.disabled || undefined}
        className="option"
        onMouseMove={onHover}
        onClick={() => row.run?.()}
      >
        <span className="sr-only">{row.group}: </span>
        {/* Icons hide themselves; a tile's number stays readable. */}
        <span className="grid w-4 shrink-0 place-items-center">{row.icon}</span>
        <span className="truncate">{row.label}</span>
        {row.hint && (
          <span className="ml-auto min-w-0 max-w-[50%] truncate text-ink-2">{row.hint}</span>
        )}
      </div>
    </>
  );
}
