import {
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Icon } from "../../icons.tsx";
import { errorText, InlineError } from "../../ui.tsx";
import { useMesaCommands } from "../palette/palette.tsx";
import { ProjectTag } from "../projects/project-tag.tsx";
import { type BlockEditing, BlockEditor, OrganizeBlocks } from "./block-bar.tsx";
import { isPanel, MAX_TILES, TILE_MIME } from "./grid-state.ts";
import { HarnessLogo } from "./logos.tsx";
import {
  assignMesa,
  blocksOf,
  groupByState,
  type Proposal,
  seedBlocks,
  suggestBlock,
} from "./mesa-blocks.ts";
import { type Editing, MesaRename } from "./mesa-rename.tsx";
import { MesaStatus, type MesaSummary, mesaAge, useMesaSummaries } from "./mesa-view.tsx";
import {
  activeMesa,
  changeMesas,
  closeMesa,
  createMesa,
  isAutoName,
  type MesaState,
  moveTerminal,
  readMesas,
  reorderMesa,
  splitName,
  type Workspace,
} from "./mesas.ts";
import { useNarrow } from "./mobile.tsx";
import { PhaseIcon, phaseOf, rowText, waitColor } from "./panel.tsx";
import { kindLabel, useTerminalAction } from "./queries.ts";
import { sendIntent } from "./workspace-sync.tsx";

// A Mesa dragged to reorder the list; a tile's header carries TILE_MIME instead.
const MESA_MIME = "application/x-aos-mesa";
// A terminal of no Mesa, dragged from «Fuera de las Mesas»: it carries TILE_MIME too, and may
// go into the open Mesa, which a tile already in it may not.
const LOOSE_MIME = "application/x-aos-loose";
// «+ Mesa» and «+ Bloque» over the cards: one look, the plus in the same place.
const HEAD_ACTION = "btn-ghost shrink-0 gap-1 text-[11px]";
const PANEL_REFUSED =
  "Solo se mueven terminales: Git y la salida de un entorno se abren en cada Mesa.";
// A group's dot, in the colour of what it holds.
const GROUP_DOT = { waits: "bg-warn", runs: "bg-primary", done: "bg-ok" } as const;
// A card's frame: quiet at rest, the accent when open, its wait's colour (`--kc`) while it
// waits on the user. The dark variants repeat the light ones over the Tabs defaults.
const CARD_REST = "border-[color-mix(in_oklab,var(--line)_70%,transparent)] bg-[var(--panel)]";
const CARD_OPEN =
  "data-active:border-[color-mix(in_oklab,var(--accent)_55%,transparent)] data-active:bg-[color-mix(in_oklab,var(--accent)_9%,var(--panel))] dark:data-active:border-[color-mix(in_oklab,var(--accent)_55%,transparent)] dark:data-active:bg-[color-mix(in_oklab,var(--accent)_9%,var(--panel))]";
const CARD_WAITS =
  "border-[color-mix(in_oklab,var(--kc)_55%,transparent)] bg-[color-mix(in_oklab,var(--kc)_8%,var(--panel))] data-active:bg-[color-mix(in_oklab,var(--kc)_12%,var(--panel))] dark:data-active:bg-[color-mix(in_oklab,var(--kc)_12%,var(--panel))]";

type Notice = { ok: boolean; text: string };

// A Mesa whose last panel just left (moved, or "Quitar") offers to close itself. Only a
// change seen while the shared Mesas are ready counts: never a load, a new Mesa, or the only
// Mesa. It lives above the Mesa page, which remounts whenever the active Mesa changes.
export function useEmptiedMesa(workspace: Workspace, ready: boolean) {
  const [emptied, setEmptied] = useState<string | null>(null);
  const sizes = useRef<Map<string, number> | null>(null);
  useEffect(() => {
    const before = ready ? sizes.current : null;
    sizes.current = ready ? new Map(workspace.mesas.map((x) => [x.id, x.ids.length])) : null;
    if (!before || workspace.mesas.length < 2) return;
    const gone = workspace.mesas.find((x) => !x.ids.length && (before.get(x.id) ?? 0) > 0);
    if (gone) setEmptied(gone.id);
  }, [workspace, ready]);
  const still = workspace.mesas.some((x) => x.id === emptied && !x.ids.length);
  return [still ? emptied : null, setEmptied] as const;
}

// The Mesas as cards grouped by where they stand (what waits on the user, what runs, what is
// done), for the rail; and the open Mesa's tiles. One Tabs root holds both, so `rail` places
// the cards and the tiles go under `children`. A Mesa's block shows as a dot on its card; what
// to do with a Mesa is in its card's menu («⋯» or a right click).
export function MesaTabs({
  workspace,
  selected,
  onSelect,
  onNotice,
  emptied,
  onEmptied,
  listShown,
  onOpenTerminal,
  bar,
  rail,
  children,
}: {
  workspace: Workspace;
  selected: string;
  onSelect: (id: string) => void;
  onNotice: (notice: Notice) => void;
  emptied: string | null;
  onEmptied: (id: string | null) => void;
  // The cards are in sight; otherwise a select picks the Mesa.
  listShown: boolean;
  // A terminal in no Mesa, opened in this one.
  onOpenTerminal: (id: string) => void;
  bar: ReactNode;
  // `count`: the Mesas; `waits`: how many of them wait on the user.
  rail: (mesas: { body: ReactNode; count: number; waits: number }) => ReactNode;
  children: ReactNode;
}) {
  const narrow = useNarrow();
  const { views, terminals, projects } = useMesaSummaries(workspace);
  const m = activeMesa(workspace, selected);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [over, setOver] = useState<string | null>(null);
  // A tile held over the list's free room or "+": dropped, it goes to a new Mesa.
  const [overNew, setOverNew] = useState(false);
  // Where a dragged Mesa would land: before or after this one.
  const [place, setPlace] = useState<{ id: string; after: boolean } | null>(null);
  // Each card's place while the pointer is over the list, so nothing moves under it.
  const [hold, setHold] = useState<Map<string, number> | null>(null);
  // The Mesa whose menu is open («⋯» or a right click); "" for the open Mesa's, by the select.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // An item that opens a popover keeps the focus from going back to «⋯», which would close it.
  const opening = useRef(false);
  const list = useRef<HTMLDivElement>(null);
  const tools = useRef<HTMLSpanElement>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const blockAnchor = useRef<HTMLElement | null>(null);
  const [blockEditing, setBlockEditing] = useState<BlockEditing | null>(null);
  const [proposal, setProposal] = useState<Proposal[] | null>(null);
  // The Mesa whose close asks first.
  const [closing, setClosing] = useState<string | null>(null);
  // A Mesa's card, or the select's tools while the cards are out of sight.
  const cardOf = (id: string) =>
    list.current?.querySelector<HTMLElement>(`[data-mesa="${CSS.escape(id)}"]`) ?? tools.current;
  // Resolved when shown: the list is a new element after the page remounts.
  const emptiedAt = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () =>
          (
            list.current?.querySelector(`[data-mesa="${CSS.escape(emptied ?? "")}"]`) ??
            tools.current
          )?.getBoundingClientRect() ?? new DOMRect(),
      },
    }),
    [emptied],
  );
  const emptiedView = workspace.mesas.find((x) => x.id === emptied);
  const closingAt = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () =>
          (
            list.current?.querySelector(`[data-mesa="${CSS.escape(closing ?? "")}"]`) ??
            tools.current
          )?.getBoundingClientRect() ?? new DOMRect(),
      },
    }),
    [closing],
  );

  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[data-state="active"]')?.focus({
      preventScroll: true,
    });
  }, []);

  const closingView = views.find((v) => v.mesa.id === closing);
  const blocks = blocksOf(workspace);
  const blockOf = (mesa: MesaState) => blocks.find((b) => b.id === mesa.block) ?? null;
  const groups = groupByState(views, (v) => hold?.get(v.mesa.id) ?? v.rank);
  const groupOf = new Map(groups.flatMap((g) => g.items.map((v) => [v.mesa.id, g.key])));
  const ordered = groups.flatMap((g) => g.items);
  const loudMesas = views.filter((v) => v.loud).length;
  const inMesas = new Set(workspace.mesas.flatMap((x) => x.ids));
  // Terminals no Mesa shows: never out of sight. The ended ones wait here to be closed.
  const loose = terminals.filter((t) => !inMesas.has(t.id));
  const ended = loose.filter((t) => t.state !== "running");
  const action = useTerminalAction();
  const closeEnded = (ids: string[]) => {
    for (const id of ids) action.mutate({ id, action: "remove" });
  };
  const assign = (id: string, block: string | null) => {
    const was = workspace.mesas.find((x) => x.id === id)?.block ?? null;
    if (was === block) return;
    sendIntent({ kind: "assign", mesa: id, block }, (s) => assignMesa(s, id, block));
  };
  const newBlock = (at: HTMLElement | null, mesa?: string) => {
    blockAnchor.current = at;
    const used = new Set(blocks.map((b) => b.color));
    const color = (["blue", "green", "amber", "rose", "violet", "slate"] as const).find(
      (c) => !used.has(c),
    );
    setBlockEditing({
      id: crypto.randomUUID(),
      name: "",
      color: color ?? "slate",
      mesa,
      isNew: true,
    });
  };
  const select = (id: string) => {
    setEditing(null);
    onSelect(id);
  };
  // A new Mesa, with the terminal dropped on it; it opens, in the open Mesa's block.
  const newMesa = (tile?: string) => {
    const id = crypto.randomUUID();
    const local = (s: Workspace) => {
      const made = createMesa(s, id);
      return tile ? moveTerminal(made, tile, id) : made;
    };
    const made = activeMesa(local(readMesas()), id);
    select(
      sendIntent(
        {
          kind: "create",
          mesa: id,
          name: made.name,
          ...(tile && { tile }),
          ...(made.block && { block: made.block }),
        },
        local,
      ).activeId,
    );
  };
  const close = (id: string) =>
    select(sendIntent({ kind: "close", mesa: id }, (s) => closeMesa(s, id)).activeId);
  // A Mesa with terminals asks first: they keep running, under «Fuera de las Mesas».
  const askClose = (mesa: MesaState) =>
    mesa.ids.some((id) => !isPanel(id)) ? setClosing(mesa.id) : close(mesa.id);
  const edit = (mesa: MesaState, at: HTMLElement | null) => {
    anchor.current = at ?? tools.current;
    const { icon, base } = splitName(mesa.name);
    setEditing({ id: mesa.id, name: isAutoName(mesa.name) ? "" : base, icon, error: null });
  };

  // The open Mesa's menu, also in ⌘K.
  const openLabel = views.find((v) => v.mesa.id === m.id)?.label;
  useMesaCommands([
    {
      key: "rename",
      label: "Renombrar la Mesa",
      hint: openLabel,
      icon: "pencil",
      run: () => edit(m, cardOf(m.id)),
    },
    ...blocks
      .filter((b) => b.id !== m.block)
      .map((b) => ({
        key: `block:${b.id}`,
        label: `Mover la Mesa a «${b.name}»`,
        hint: openLabel,
        icon: "mesa" as const,
        run: () => assign(m.id, b.id),
      })),
    ...(m.block
      ? [
          {
            key: "unblock",
            label: "Sacar la Mesa de su bloque",
            hint: openLabel,
            icon: "mesa" as const,
            run: () => assign(m.id, null),
          },
        ]
      : []),
    {
      key: "new-block",
      label: "Nuevo bloque de Mesas",
      icon: "plus",
      run: () => newBlock(cardOf(m.id)),
    },
    {
      key: "close",
      label: "Cerrar la Mesa",
      hint: openLabel,
      icon: "close",
      run: () => close(m.id),
    },
  ]);

  // A tile's header dropped on a Mesa moves that terminal into it, like "Mover a otra Mesa".
  // A Mesa dropped on another goes above or below it, by the half it lands on.
  const after = (e: DragEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY > r.top + r.height / 2;
  };
  const reorder = (id: string, target: string, behind: boolean) =>
    changeMesas((s) => {
      const rest = s.mesas.filter((x) => x.id !== id);
      return reorderMesa(s, id, rest.findIndex((x) => x.id === target) + (behind ? 1 : 0));
    });
  const drop = (v: MesaSummary) => ({
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (e.dataTransfer.types.includes(MESA_MIME)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setPlace({ id: v.mesa.id, after: after(e) });
        return;
      }
      const types = e.dataTransfer.types;
      if (!types.includes(TILE_MIME) || (v.mesa.id === m.id && !types.includes(LOOSE_MIME))) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setOver(v.mesa.id);
    },
    onDragLeave: () => {
      setOver((o) => (o === v.mesa.id ? null : o));
      setPlace((p) => (p?.id === v.mesa.id ? null : p));
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      const tab = e.dataTransfer.getData(MESA_MIME);
      const id = e.dataTransfer.getData(TILE_MIME);
      setOver(null);
      setPlace(null);
      if (tab) {
        e.preventDefault();
        if (tab !== v.mesa.id) reorder(tab, v.mesa.id, after(e));
        return;
      }
      if (!id || (v.mesa.id === m.id && !e.dataTransfer.getData(LOOSE_MIME))) return;
      e.preventDefault();
      if (isPanel(id)) return onNotice({ ok: false, text: PANEL_REFUSED });
      if (v.mesa.ids.length >= MAX_TILES)
        return onNotice({
          ok: false,
          text: `«${v.label}» ya tiene ${MAX_TILES} paneles: quita uno antes de mover otra terminal.`,
        });
      select(
        sendIntent({ kind: "move", mesa: v.mesa.id, tile: id }, (s) =>
          moveTerminal(s, id, v.mesa.id),
        ).activeId,
      );
      onNotice({ ok: true, text: `Terminal movida a «${v.label}».` });
    },
  });
  // A tile's header dropped on the list's free room or on "+" opens a new Mesa with that
  // terminal, from any Mesa, the open one included.
  const toNewMesa = {
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!e.dataTransfer.types.includes(TILE_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setOverNew(true);
    },
    onDragLeave: () => setOverNew(false),
    onDrop: (e: DragEvent<HTMLElement>) => {
      setOverNew(false);
      const tile = e.dataTransfer.getData(TILE_MIME);
      if (!tile) return;
      e.preventDefault();
      if (isPanel(tile)) return onNotice({ ok: false, text: PANEL_REFUSED });
      // The new Mesa opens; that is the feedback.
      newMesa(tile);
    },
  };
  // ↑↓ move within a group and on to the next one; Alt+↑↓ moves the Mesa within its group; F2
  // renames it; Supr closes it.
  const rowKeys = (v: MesaSummary) => (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "F2") {
      e.preventDefault();
      return edit(v.mesa, e.currentTarget);
    }
    if (e.key === "Delete") {
      e.preventDefault();
      return askClose(v.mesa);
    }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    const back = e.key === "ArrowUp";
    const next = ordered[ordered.indexOf(v) + (back ? -1 : 1)];
    const same = !!next && groupOf.get(next.mesa.id) === groupOf.get(v.mesa.id);
    if (e.altKey) {
      // preventDefault keeps Radix from moving the focus.
      e.preventDefault();
      if (next && same) reorder(v.mesa.id, next.mesa.id, !back);
      return;
    }
    // Within a group Radix moves the focus; across groups it goes to the next group's card.
    if (!next || same) return;
    e.preventDefault();
    cardOf(next.mesa.id)?.focus();
  };

  // What to do with a Mesa: its card's «⋯» and right click, and the select's «⋯». Built only
  // while open.
  const popover = (run: () => void) => () => {
    opening.current = true;
    run();
  };
  const menuItems = (mesa: MesaState) => {
    const at = () => cardOf(mesa.id);
    const block = blockOf(mesa);
    const suggested = projects ? suggestBlock(workspace, mesa, terminals, projects) : null;
    return (
      <>
        <DropdownMenuItem onSelect={popover(() => edit(mesa, at()))}>
          <Icon name="pencil" />
          Renombrar
          <DropdownMenuShortcut>F2</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Icon name="mesa" />
            Mover a bloque
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {suggested && (
              <DropdownMenuItem onSelect={() => assign(mesa.id, suggested.id)}>
                <span
                  data-block={suggested.color}
                  className="size-2 rounded-full bg-[var(--blk)]"
                />
                {suggested.name} (sugerido)
              </DropdownMenuItem>
            )}
            {blocks
              .filter((b) => b.id !== suggested?.id)
              .map((b) => (
                <DropdownMenuItem
                  key={b.id}
                  disabled={mesa.block === b.id}
                  onSelect={() => assign(mesa.id, b.id)}
                >
                  <span data-block={b.color} className="size-2 rounded-full bg-[var(--blk)]" />
                  {b.name}
                </DropdownMenuItem>
              ))}
            {mesa.block && (
              <DropdownMenuItem onSelect={() => assign(mesa.id, null)}>Sin bloque</DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={popover(() => newBlock(at(), mesa.id))}>
              Bloque nuevo…
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {block && (
          <DropdownMenuItem
            onSelect={popover(() => {
              blockAnchor.current = at();
              setBlockEditing({ id: block.id, name: block.name, color: block.color, isNew: false });
            })}
          >
            <span data-block={block.color} className="size-2 rounded-full bg-[var(--blk)]" />
            Editar bloque «{block.name}»…
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          disabled={!projects}
          onSelect={popover(() => {
            blockAnchor.current = at();
            if (projects) setProposal(seedBlocks(workspace, terminals, projects));
          })}
        >
          <Icon name="folder" />
          Organizar por proyecto…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => close(mesa.id)}>
          <Icon name="close" />
          Cerrar Mesa
          <DropdownMenuShortcut>Supr</DropdownMenuShortcut>
        </DropdownMenuItem>
      </>
    );
  };
  const menu = (mesa: MesaState, key: string, trigger: ReactNode) => (
    <DropdownMenu open={menuFor === key} onOpenChange={(open) => setMenuFor(open ? key : null)}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(e) => {
          if (!opening.current) return;
          opening.current = false;
          e.preventDefault();
        }}
      >
        {menuFor === key && menuItems(mesa)}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // A card: its lead's harness, its block's dot, its name and why it waits (or a spinner while
  // it works); then what the lead asks or said last, and its project and age. The extra lines
  // are hidden from the tab's name, which stays the Mesa's own.
  const card = (v: MesaSummary) => {
    const block = blockOf(v.mesa);
    // A turn looked at waits quietly; a finished Mesa keeps its name in plain ink and a check.
    const seen = v.rank === 3;
    const age = mesaAge(v);
    return (
      <div key={v.mesa.id} className="group/mesa relative w-full min-w-0">
        <TabsTrigger
          data-mesa={v.mesa.id}
          value={v.mesa.id}
          title={`${v.hover}${v.where ? `\n${v.where}` : ""}`}
          onDoubleClick={(e) => edit(v.mesa, e.currentTarget)}
          onKeyDown={rowKeys(v)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenuFor(v.mesa.id);
          }}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(MESA_MIME, v.mesa.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={() => setPlace(null)}
          {...drop(v)}
          data-drop={over === v.mesa.id || undefined}
          data-place={place?.id === v.mesa.id ? (place.after ? "after" : "before") : undefined}
          data-wait={v.loud ?? undefined}
          style={v.loud ? ({ "--kc": waitColor(v.loud) } as CSSProperties) : undefined}
          aria-describedby={`mesa-where-${v.mesa.id}`}
          className={`h-auto min-w-0 flex-col items-stretch justify-start gap-1 whitespace-normal rounded-[9px] border px-2 pt-1.5 pb-2 text-left font-normal text-[12px] text-ink after:hidden hover:bg-[var(--hover)] data-active:text-ink data-active:shadow-none data-[drop]:ring-1 data-[drop]:ring-primary data-[place=after]:shadow-[inset_0_-2px_0_var(--accent)] data-[place=before]:shadow-[inset_0_2px_0_var(--accent)] ${v.loud ? CARD_WAITS : CARD_REST} ${CARD_OPEN}`}
        >
          <span className="flex min-h-5 w-full min-w-0 items-center gap-1.5 pr-6">
            <span
              aria-hidden
              title={v.lead ? kindLabel(v.lead) : undefined}
              className="grid w-3 shrink-0"
            >
              {v.lead && <HarnessLogo kind={v.lead.harness} size={12} />}
            </span>
            {block && (
              <span
                aria-hidden
                data-block={block.color}
                title={`Bloque ${block.name}`}
                className="size-1.5 shrink-0 rounded-full bg-[var(--blk)]"
              />
            )}
            {v.icon && <span aria-hidden>{v.icon}</span>}
            {v.badge && (
              <span className="pill h-4 shrink-0 px-1 font-mono text-[10px]">{v.badge}</span>
            )}
            {v.text && (
              <span
                className={`min-w-0 truncate text-[13px] ${seen ? "text-ink-2" : "font-medium"}`}
              >
                {v.text}
              </span>
            )}
            <MesaStatus v={v} wide />
          </span>
          {(v.line || v.project || age) && (
            <span
              aria-hidden
              className="flex w-full min-w-0 flex-col gap-0.5 pl-[18px] font-mono text-[11px] text-ink-2 leading-snug"
            >
              {v.line && <span className="truncate text-ink/80">❯ {v.line}</span>}
              <span className="flex min-w-0 items-center gap-1.5">
                {v.project && <ProjectTag name={v.project} />}
                <span className="shrink-0">{age}</span>
              </span>
            </span>
          )}
          {/* What the Mesa holds describes the tab; its name stays the Mesa's own. */}
          <span id={`mesa-where-${v.mesa.id}`} aria-hidden className="sr-only">
            {v.where || "Sin terminales"}
          </span>
        </TabsTrigger>
        {menu(
          v.mesa,
          v.mesa.id,
          // Out of the tab order: the right click, F2 and Supr on the card do the same.
          <button
            type="button"
            tabIndex={-1}
            className="btn-ghost absolute top-1.5 right-1 size-6 justify-center p-0 opacity-0 group-focus-within/mesa:opacity-100 group-hover/mesa:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
            aria-label={`Opciones de ${v.label}`}
            title="Opciones de la Mesa"
          >
            ⋯
          </button>,
        )}
      </div>
    );
  };

  const body = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2 pt-1.5">
        <button
          type="button"
          className={`${HEAD_ACTION} data-[drop]:ring-1 data-[drop]:ring-primary`}
          aria-label="Nueva Mesa"
          title="Nueva Mesa · suelta aquí una terminal para llevarla a una Mesa nueva"
          onClick={() => newMesa()}
          {...toNewMesa}
          data-drop={overNew || undefined}
        >
          <Icon name="plus" size={12} />
          Mesa
        </button>
        <button
          type="button"
          className={HEAD_ACTION}
          aria-label="Nuevo bloque de Mesas"
          title="Nuevo bloque de Mesas"
          onClick={(e) => newBlock(e.currentTarget)}
        >
          <Icon name="plus" size={12} />
          Bloque
        </button>
      </div>
      <div
        ref={list}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden px-2 pt-2 pb-2"
        onPointerEnter={() => setHold(new Map(views.map((v) => [v.mesa.id, v.rank])))}
        onPointerLeave={() => setHold(null)}
      >
        {!groups.some((g) => g.key === "waits") && (
          <p className="flex items-center gap-1.5 px-1 text-[11px] text-ink-2">
            <span className="size-1.5 rounded-full bg-[color-mix(in_oklab,var(--ink-2)_50%,transparent)]" />
            Nadie te espera.
          </p>
        )}
        {groups.map((g) => (
          <section key={g.key} aria-label={g.name} className="flex flex-col gap-1.5">
            <h3 className="flex items-center gap-1.5 px-1 font-semibold text-[11px] text-ink-2">
              <span className={`size-1.5 rounded-full ${GROUP_DOT[g.key]}`} />
              {g.name}
              <span className="font-normal tabular-nums">{g.items.length}</span>
            </h3>
            <TabsList aria-label={g.name} className="w-full gap-1.5 bg-transparent p-0">
              {g.items.map(card)}
            </TabsList>
          </section>
        ))}
        {/* Under the cards, so a long list of loose terminals never pushes it out of sight. */}
        <div
          data-new-mesa
          {...toNewMesa}
          data-drop={overNew || undefined}
          className="group/new flex min-h-8 shrink-0 items-center justify-center rounded text-[12px] text-ink-2 data-[drop]:bg-[var(--selected)] data-[drop]:ring-1 data-[drop]:ring-primary"
        >
          <span className="pointer-events-none hidden items-center gap-1 group-data-[drop]/new:flex">
            <Icon name="plus" size={12} />
            Nueva Mesa
          </span>
        </div>
        {loose.length > 0 && (
          <section aria-label="Fuera de las Mesas">
            <div className="flex items-center px-1 pb-0.5">
              <h3 className="font-semibold text-[11px] text-ink-2">
                Fuera de las Mesas <span className="font-normal tabular-nums">{loose.length}</span>
              </h3>
              {ended.length > 1 && (
                <button
                  type="button"
                  className="btn-ghost ml-auto text-[11px]"
                  disabled={action.isPending}
                  title="Terminadas o perdidas, fuera de las Mesas"
                  onClick={() => closeEnded(ended.map((t) => t.id))}
                >
                  Cerrar terminadas ({ended.length})
                </button>
              )}
            </div>
            <ul className="space-y-px">
              {loose.map((t) => (
                <li key={t.id} className="group/loose flex items-center">
                  <button
                    type="button"
                    data-loose={t.id}
                    className="row min-w-0 flex-1 text-left text-[12px]"
                    title="Abrir en esta Mesa · arrástrala a una Mesa"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(TILE_MIME, t.id);
                      e.dataTransfer.setData(LOOSE_MIME, t.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onClick={() => onOpenTerminal(t.id)}
                  >
                    <PhaseIcon phase={phaseOf(t)} pulse={false} title={phaseOf(t).label} />
                    <span className="min-w-0 flex-1 truncate">{rowText(t)}</span>
                  </button>
                  {t.state !== "running" && (
                    <button
                      type="button"
                      className="btn-ghost size-6 shrink-0 justify-center p-0"
                      aria-label={`Cerrar ${rowText(t)}`}
                      title="Cerrar la terminal: ya no está en marcha"
                      disabled={action.isPending}
                      onClick={() => closeEnded([t.id])}
                    >
                      <Icon name="close" size={12} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {action.isError && (
              <InlineError className="px-2 pt-1 text-[11px]">
                No se ha podido cerrar: {errorText(action.error)}
              </InlineError>
            )}
          </section>
        )}
      </div>
    </div>
  );

  return (
    <Tabs
      value={m.id}
      onValueChange={select}
      orientation="vertical"
      activationMode="manual"
      className="min-h-0 min-w-0 flex-1 flex-col gap-0"
    >
      {bar}
      <div className="relative flex min-h-0 flex-1">
        {rail({ body, count: views.length, waits: loudMesas })}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {(narrow || !listShown) && (
            <div className="flex min-h-11 shrink-0 items-center gap-1 border-line border-b bg-panel px-2 md:min-h-9">
              <select
                aria-label="Mesa activa"
                value={m.id}
                onChange={(e) => select(e.target.value)}
                className="min-h-11 min-w-0 flex-1 bg-panel px-2 text-[12px] md:min-h-8"
              >
                {groups.map((g) => (
                  <optgroup key={g.key} label={g.name}>
                    {g.items.map((v) => (
                      <option key={v.mesa.id} value={v.mesa.id}>
                        {v.icon ? `${v.icon} ` : ""}
                        {v.label}
                        {v.count ? " · atención pendiente" : ""}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <span ref={tools} className="flex shrink-0 items-center">
                {menu(
                  m,
                  "",
                  <button
                    type="button"
                    className="btn-ghost shrink-0"
                    aria-label="Opciones de la Mesa"
                    title="Opciones de la Mesa"
                  >
                    ⋯
                  </button>,
                )}
              </span>
            </div>
          )}
          <TabsContent value={m.id} className="flex min-h-0 flex-1 flex-col">
            {children}
          </TabsContent>
        </div>
      </div>
      <Popover open={!!emptiedView} onOpenChange={(open) => !open && onEmptied(null)}>
        <PopoverAnchor virtualRef={emptiedAt} />
        <PopoverContent
          align="start"
          role="alertdialog"
          aria-label="Mesa vacía"
          className="w-72 text-[12px]"
          // The user may be typing in a terminal: the question never takes the focus, and a
          // terminal taking it (the one just moved mounts focused) does not dismiss it. A click
          // outside or Esc does.
          onOpenAutoFocus={(e) => e.preventDefault()}
          onFocusOutside={(e) => e.preventDefault()}
        >
          {emptiedView && (
            <>
              <p>
                «{views.find((v) => v.mesa.id === emptiedView.id)?.label ?? emptiedView.name}» se ha
                quedado vacía. ¿La cierras?
              </p>
              <div className="flex justify-end gap-2">
                <button type="button" className="btn-ghost" onClick={() => onEmptied(null)}>
                  Mantener
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    const id = emptiedView.id;
                    onEmptied(null);
                    close(id);
                  }}
                >
                  Cerrar Mesa
                </button>
              </div>
            </>
          )}
        </PopoverContent>
      </Popover>
      <Popover open={!!closingView} onOpenChange={(open) => !open && setClosing(null)}>
        <PopoverAnchor virtualRef={closingAt} />
        <PopoverContent
          align="start"
          role="alertdialog"
          aria-label="Cerrar Mesa"
          className="w-72 text-[12px]"
        >
          {closingView && (
            <>
              <p>
                ¿Cerrar «{closingView.label}»? Sus{" "}
                {closingView.mesa.ids.filter((id) => !isPanel(id)).length} terminales siguen
                abiertas, en «Fuera de las Mesas».
              </p>
              <div className="flex justify-end gap-2">
                <button type="button" className="btn-ghost" onClick={() => setClosing(null)}>
                  Cancelar
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    const id = closingView.mesa.id;
                    setClosing(null);
                    close(id);
                  }}
                >
                  Cerrar Mesa
                </button>
              </div>
            </>
          )}
        </PopoverContent>
      </Popover>
      <MesaRename
        editing={editing}
        onEditing={setEditing}
        anchor={anchor}
        placeholder={views.find((v) => v.mesa.id === editing?.id)?.label ?? "Automático"}
      />
      <BlockEditor editing={blockEditing} onEditing={setBlockEditing} anchor={blockAnchor} />
      <OrganizeBlocks
        proposal={proposal}
        onProposal={setProposal}
        anchor={blockAnchor}
        mesaLabel={(id) => views.find((v) => v.mesa.id === id)?.label ?? id}
      />
    </Tabs>
  );
}
