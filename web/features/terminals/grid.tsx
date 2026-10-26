import { useNavigate } from "@tanstack/react-router";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../../icons.tsx";
import { PageBar } from "../../page-bar.tsx";
import { useOpen } from "../../ui.tsx";
import { useMesaBridge, usePalette } from "../palette/palette.tsx";
import { RailSources } from "../projects/rail-sources.tsx";
import {
  type BringItem,
  bringBlocked,
  bringErrorText,
  bringLabel,
  bringTo,
  type Target,
} from "./bring.ts";
import { DraftShelf } from "./draft-strip.tsx";
import {
  closeSlot,
  cssLen,
  dock,
  fill,
  type GridSearch,
  inset,
  isPanel,
  isSlot,
  type Layout,
  layoutRects,
  MAX_TILES,
  preset,
  readLayout,
  reconcile,
  resizeSplit,
  type Side,
  swap,
  tiles,
} from "./grid-state.ts";
import { Border, Dock, GAP, PAD, PRESETS, Slot } from "./mesa-layout.tsx";
import { Rail } from "./mesa-rail.tsx";
import { MesaTabs, useEmptiedMesa } from "./mesa-tabs.tsx";
import {
  activeMesa,
  changeMesas,
  type MesaState,
  moveTerminal,
  openInMesa,
  readMesas,
  resolveMesaSearch,
  updateMesa,
  useMesas,
  type Workspace,
} from "./mesas.ts";
import { useNarrow } from "./mobile.tsx";
import {
  MesaOverview,
  type MesaView,
  mesaView,
  type Overview,
  ViewSwitch,
  viewName,
} from "./overview.tsx";
import { MesaContext } from "./place.ts";
import {
  createTerminal,
  type TerminalInfo,
  terminalLabel,
  useLaunch,
  useTerminals,
} from "./queries.ts";
import { Tile, tileName } from "./tile.tsx";
import { WorkBar } from "./work-bar.tsx";
import { sendIntent, tileIntents, WorkspaceReady } from "./workspace-sync.tsx";

// The route (web/app.tsx) types its search with it.
export type { GridSearch } from "./grid-state.ts";

type Notice = { ok: boolean; text: string };

// The Mesa: terminals and panels (git, an env's output) side by side, each live and numbered,
// with a rail that lists the Mesas over the projects, whose tickets and PRs drag into a tile. Each named Mesa keeps its view in the workspace store; URL intents resolve once.
export function GridPage({ search }: { search: GridSearch }) {
  const navigate = useNavigate();
  const { workspace, saved } = useMesas();
  const ready = useContext(WorkspaceReady);
  const [importNotice, setImportNotice] = useState("");
  const [emptied, setEmptied] = useEmptiedMesa(workspace, ready);
  const narrow = useNarrow();
  // A link that names a terminal, a node or tiles opens Terminales; a narrow screen has no
  // overview. A plain visit returns to the view seen last.
  const bare = Object.values(search).every((v) => v === undefined);
  const intent = search.ids !== undefined || !!search.t || !!search.max || !!search.node;
  const shown = narrow || intent ? undefined : search.view;
  // Where «Volver» leads after a Mesa opened from an overview, and the tile it opened on.
  const [back, setBack] = useState<Overview | null>(null);
  const [focus, setFocus] = useState<{ mesa: string; tile: string } | null>(null);
  // Resolve URL intent against current ownership once per navigation. Tile/layout changes
  // write the store directly and never replay an old URL snapshot.
  useEffect(() => {
    if (!ready) return;
    const before = readMesas();
    const result = resolveMesaSearch(before, search);
    // A link only adds what it names (or, an old one, its tiles): one intent per tile.
    const [first, ...more] = result.workspace.mesas.flatMap((m) =>
      tileIntents(m.id, before.mesas.find((b) => b.id === m.id)?.ids ?? [], m.ids),
    );
    if (first) sendIntent(first, () => result.workspace);
    else changeMesas(() => result.workspace);
    for (const next of more) sendIntent(next, (s) => s);
    if (result.omitted.length)
      setImportNotice(
        `Algunas terminales siguen en ${result.omitted.join(", ")}. Ábrelas desde el listado.`,
      );
    const stored = mesaView.get();
    const view = narrow
      ? undefined
      : bare
        ? stored === "terminales"
          ? undefined
          : stored
        : intent
          ? undefined
          : search.view;
    if (intent || view !== search.view || search.mesa !== result.workspace.activeId)
      void navigate({
        to: "/terminales",
        search: { mesa: result.workspace.activeId, ...(view && { view }) },
        replace: true,
      });
  }, [search, navigate, ready, narrow, bare, intent]);
  // The view in the URL is the one to return to; a plain visit leaves it as it was.
  useEffect(() => {
    if (ready && !narrow && !bare) mesaView.set(shown ?? "terminales");
  }, [ready, narrow, bare, shown]);
  // Resolve during render too: direct/legacy links and server-rendered tests show the same
  // view before the canonical URL is written. Resolution is pure.
  if (!ready)
    return (
      <p role="status" className="p-3 text-ink-2">
        Cargando la Mesa…
      </p>
    );
  const view = resolveMesaSearch(workspace, search).workspace;
  const active = activeMesa(view);
  const onView = (v: MesaView) => {
    setBack(null);
    void navigate({
      to: "/terminales",
      search: { mesa: active.id, ...(v !== "terminales" && { view: v }) },
    });
  };
  const onOpen = (mesa: string, tile?: string) => {
    setBack(shown ?? null);
    setFocus(tile ? { mesa, tile } : null);
    void navigate({ to: "/terminales", search: { mesa } });
  };
  return (
    <>
      {!saved && (
        <p role="alert" className="bg-panel px-3 py-1 text-warn text-[12px]">
          La distribución de los paneles no se guardará al recargar: el almacenamiento local no está
          disponible.
        </p>
      )}
      {importNotice && (
        <p role="status" className="bg-panel px-3 py-1 text-[12px] text-ink-2">
          {importNotice}
        </p>
      )}
      {shown ? (
        <MesaOverview view={shown} workspace={view} onView={onView} onOpen={onOpen} />
      ) : (
        <MesaPage
          key={active.id}
          search={{ node: active.node }}
          current={active}
          workspace={view}
          emptied={emptied}
          onEmptied={setEmptied}
          onView={onView}
          back={back}
          focusTile={focus?.mesa === active.id ? focus.tile : undefined}
          onFocusTaken={() => setFocus(null)}
        />
      )}
    </>
  );
}

function MesaPage({
  search,
  current,
  workspace,
  emptied,
  onEmptied,
  onView,
  back,
  focusTile,
  onFocusTaken,
}: {
  search: GridSearch;
  current: MesaState;
  workspace: Workspace;
  emptied: string | null;
  onEmptied: (id: string | null) => void;
  onView: (v: MesaView) => void;
  // The overview this Mesa was opened from, for «Volver».
  back: Overview | null;
  // The terminal it was opened on, which takes the keys once.
  focusTile?: string;
  onFocusTaken: () => void;
}) {
  const navigate = useNavigate();
  const select = (id: string) => {
    void navigate({ to: "/terminales", search: { mesa: id } });
  };
  const read = useTerminals().data;
  const all = read?.terminals ?? [];
  const ids = current.ids;
  const narrow = useNarrow();
  const mobileTile = current.mobileId;
  // A terminal opened on a full Mesa shows alone without joining the grid, so a command
  // asking a question is never out of sight. Until the terminals are read it is kept.
  const max =
    current.max &&
    (ids.includes(current.max) ||
      isPanel(current.max) ||
      !read ||
      all.some((t) => t.id === current.max))
      ? current.max
      : undefined;
  // The rail starts open and remembers being folded.
  const [picking, togglePicking] = useOpen("mesa:rail:left", true);
  // A link to a node lands on it: the rail opens, and its sources show the projects tree.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new node opens the rail
  useEffect(() => {
    if (search.node && !picking) togglePicking();
  }, [search.node]);
  // «+ Claude»: an agent about no project, in the free folder, opened in this Mesa.
  const claude = useLaunch();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [focus, setFocus] = useState({ id: focusTile ?? "", seq: focusTile ? 1 : 0 });
  // biome-ignore lint/correctness/useExhaustiveDependencies: taken once, on mount
  useEffect(() => {
    if (focusTile) onFocusTaken();
  }, []);
  const kept = current.layout;
  const [dragging, setDragging] = useState<string | null>(null);
  // The browser places the tiles from the grid's own size. The size is read only for what the
  // layout cannot say by itself: how many columns a first layout gets and which way a new tile
  // splits. It is read before the first paint, so a first layout never shows in one column.
  const gridRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const read = () => setBox({ w: el.clientWidth - 2 * PAD, h: el.clientHeight - 2 * PAD });
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const tree = reconcile(kept, ids, box);
  // Tiles are numbered in the layout's reading order, so a number matches its place.
  const order = tiles(tree);
  const shape = JSON.stringify(tree);
  useEffect(() => {
    if (!box.w || !box.h) return;
    changeMesas((s) => updateMesa(s, current.id, { layout: readLayout(JSON.parse(shape)) }));
  }, [shape, current.id, box.w, box.h]);

  // Maximising is this browser's view; taking a tile out of the Mesa asks the server.
  const maximise = (tile?: string) => changeMesas((s) => updateMesa(s, current.id, { max: tile }));
  const remove = (id: string) =>
    sendIntent({ kind: "remove", mesa: current.id, tile: id }, (s) =>
      updateMesa(s, current.id, {
        ids: activeMesa(s, current.id).ids.filter((x) => x !== id),
        max: max === id ? undefined : max,
      }),
    );
  const openTile = (id: string) => {
    const before = readMesas();
    const local = (s: Workspace) => openInMesa(s, id, current.id);
    const target = activeMesa(local(before));
    // A tile already in a Mesa opens there; a full Mesa shows it alone, outside the grid.
    const joins = target.ids.includes(id) && !activeMesa(before, target.id).ids.includes(id);
    const next = joins
      ? sendIntent({ kind: "add", mesa: target.id, tile: id }, local)
      : changeMesas(local);
    select(next.activeId);
    if (!activeMesa(next).ids.includes(id))
      setNotice({
        ok: true,
        text: `La Mesa está llena (${MAX_TILES} paneles): se muestra sola, fuera de la cuadrícula.`,
      });
  };
  const open = (t: TerminalInfo) => openTile(t.id);
  const move = (id: string, target: string) =>
    select(
      sendIntent({ kind: "move", mesa: target, tile: id }, (s) => moveTerminal(s, id, target))
        .activeId,
    );

  // Panel tiles keep their number in the Mesa but take no ticket or PR.
  const targets: Target[] = order.flatMap((id, i) => {
    if (isPanel(id)) return [];
    const t = all.find((x) => x.id === id);
    return [{ id, n: i + 1, name: tileName(t), blocked: bringBlocked(t) }];
  });
  const bring = async (id: string, item: BringItem) => {
    // A terminal shown outside the grid's order (maximized from elsewhere) takes it too.
    const shownAlone = all.find((x) => x.id === id);
    const target =
      targets.find((t) => t.id === id) ??
      (shownAlone && {
        id,
        n: 0,
        name: tileName(shownAlone),
        blocked: bringBlocked(shownAlone),
      });
    if (!target) return;
    const what = bringLabel(item);
    const to = target.n ? `${target.n} · ${target.name}` : target.name;
    const prompt = "prompt" in item;
    const blocked = prompt ? bringBlocked(shownAlone, true) : target.blocked;
    if (blocked)
      return setNotice({ ok: false, text: `No se ha llevado ${what} a ${to}: ${blocked}.` });
    try {
      await bringTo(id, item);
      setNotice({
        ok: true,
        text: prompt
          ? `${what} → ${to}. Enviado.`
          : `${what} → ${to}. Revisa el texto y pulsa Enter en la terminal.`,
      });
      setFocus((f) => ({ id, seq: f.seq + 1 }));
    } catch (err) {
      setNotice({ ok: false, text: `No se ha llevado ${what} a ${to}: ${bringErrorText(err)}.` });
    }
  };

  const mobileSelected = max ?? (mobileTile && order.includes(mobileTile) ? mobileTile : order[0]);
  const shown = narrow ? (mobileSelected ? [mobileSelected] : []) : max ? [max] : order;
  // A tile shown alone fills the grid; a narrow grid stacks the tiles (NARROW_FLOW).
  const placed = layoutRects(max || narrow ? null : tree, inset(PAD), GAP);
  const commit = (next: Layout | null) => {
    changeMesas((s) => updateMesa(s, current.id, { layout: next, max }));
  };
  const place = (tile: string, at: string | null, side: Side | "center") => {
    if (!tree) return;
    if (side !== "center") return commit(dock(tree, tile, at, side));
    if (at) commit(isSlot(at) ? fill(tree, at, tile) : swap(tree, tile, at));
  };
  const palette = usePalette();
  // A border is named by the tiles on each side: "Ancho entre las terminales 1 y 2 · 3".
  const nums = (xs: string[]) =>
    xs.map((x) => (isSlot(x) ? "hueco" : order.indexOf(x) + 1)).join(" · ");
  const presets = (vertical: boolean) =>
    order.length >= 2 &&
    !max && (
      <fieldset aria-label="Distribución" className={`flex gap-0.5 ${vertical ? "flex-col" : ""}`}>
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className="btn-ghost justify-center"
            aria-label={`Distribución: ${p.label}`}
            title={`Distribución: ${p.label}`}
            onClick={() => commit(preset(p.id, order))}
          >
            <Icon name={p.icon} size={14} />
          </button>
        ))}
      </fieldset>
    );
  const mesa = { id: current.id, ids, max, node: search.node, open, openTile, move };
  useMesaBridge({ targets, bring: (id, item) => void bring(id, item), open });

  const launchClaude = () => void claude.launch(() => createTerminal("claude", "scratch"));
  const claudeButton = (
    <button
      type="button"
      className="btn-ghost shrink-0 gap-1"
      disabled={claude.pending}
      title="Claude en la carpeta libre, sin elegir proyecto"
      onClick={launchClaude}
    >
      <Icon name="plus" size={14} />
      Claude
    </button>
  );

  return (
    <MesaContext.Provider value={mesa}>
      <div className="flex min-h-0 flex-1 flex-col">
        <MesaTabs
          workspace={workspace}
          selected={current.id}
          onSelect={select}
          onNotice={setNotice}
          emptied={emptied}
          onEmptied={onEmptied}
          listShown={picking}
          onOpenTerminal={openTile}
          bar={
            <>
              <PageBar>
                <h1 className="font-semibold">Mesa</h1>
                <ViewSwitch view="terminales" onView={onView} />
                {back && (
                  <button
                    type="button"
                    className="btn-ghost shrink-0 gap-1"
                    onClick={() => onView(back)}
                  >
                    <Icon name="undo" size={14} />
                    Volver al {viewName(back)}
                  </button>
                )}
                <p
                  role="status"
                  className={`min-w-0 flex-1 truncate text-[12px] ${claude.error || notice?.ok === false ? "text-bad" : "text-ink-2"}`}
                  title={claude.error ?? notice?.text}
                >
                  {claude.error ? `No se ha abierto Claude: ${claude.error}` : notice?.text}
                </p>
                {claudeButton}
              </PageBar>
              <WorkBar />
            </>
          }
          rail={({ body, count, waits }) => (
            // The rail sits beside the tiles and takes its room from them, so nothing covers a
            // tile. The app is used on a desktop: below md there is no rail.
            <Rail
              id="grid-picker"
              label="Mesas y proyectos"
              name="el carril"
              open={picking}
              onToggle={togglePicking}
              head={
                <h2 className="flex items-center gap-1.5 px-1 font-semibold text-[12px]">
                  Mesas
                  <span className="font-normal text-[11px] text-ink-2 tabular-nums">{count}</span>
                  {waits > 0 && (
                    <span className="sr-only">
                      {waits} te {waits === 1 ? "espera" : "esperan"}
                    </span>
                  )}
                </h2>
              }
              tools={presets}
              foot={(vertical) => <DraftShelf vertical={vertical} />}
            >
              {/* The Mesas at their own height, up to 70 %; the sources take the rest. One column of the
                  rail's width: an auto one would grow to its widest row and push past the edge. */}
              <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[fit-content(70%)_minmax(160px,1fr)]">
                <div className="flex min-h-0 flex-col">{body}</div>
                <RailSources node={search.node} />
              </div>
            </Rail>
          )}
        >
          {/* Below md there is no rail: the shelf floats over the bottom left corner. */}
          {narrow && <DraftShelf floating />}
          {narrow && (
            <label className="flex shrink-0 items-center gap-2 px-3 py-2">
              Panel
              <select
                aria-label="Panel visible"
                value={mobileSelected ?? ""}
                onChange={(e) => {
                  changeMesas((s) => updateMesa(s, current.id, { mobileId: e.target.value }));
                  if (max) maximise(undefined);
                }}
                className="min-h-11 min-w-0 flex-1 rounded border border-line bg-panel px-2"
              >
                {order.map((id) => (
                  <option key={id} value={id}>
                    {all.find((t) => t.id === id)
                      ? terminalLabel(all.find((t) => t.id === id) as TerminalInfo)
                      : id}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div
            ref={gridRef}
            className="@container relative grid min-h-0 min-w-0 flex-1 auto-rows-fr gap-3 overflow-y-auto p-3 md:auto-rows-fr"
          >
            {shown.length === 0 ? (
              <div className="space-y-1 text-[12px] text-ink-2">
                <p className="font-medium text-[13px] text-ink">Esta Mesa está vacía</p>
                <p>
                  Abre una terminal con el «+» de un proyecto o con «+ Claude», y arrástrale un
                  ticket o una PR.
                </p>
              </div>
            ) : (
              // Every tile is a sibling under its own key wherever the layout puts it, so a move
              // or a resize never remounts its terminal.
              shown.map((id) => {
                const r = placed.tiles.get(id);
                const n = order.indexOf(id) + 1;
                return (
                  <Tile
                    key={id}
                    id={id}
                    n={n}
                    maximized={max === id}
                    focusSeq={focus.id === id ? focus.seq : undefined}
                    dragging={dragging}
                    style={
                      r && {
                        position: "absolute",
                        left: cssLen(r.x),
                        top: cssLen(r.y),
                        width: cssLen(r.w),
                        height: cssLen(r.h),
                      }
                    }
                    onMax={() => maximise(max === id ? undefined : id)}
                    onRemove={() => remove(id)}
                    onOpen={open}
                    onBring={(item) => void bring(id, item)}
                    onDrop={(tile, side) => place(tile, id, side)}
                    onSwap={(step) => {
                      const other = order[n - 1 + step];
                      if (other) place(id, other, "center");
                    }}
                    onDrag={max ? undefined : (moving) => setDragging(moving ? id : null)}
                  />
                );
              })
            )}
            {[...placed.tiles].map(
              ([slot, r]) =>
                isSlot(slot) && (
                  <Slot
                    key={slot}
                    dragging={dragging}
                    style={{
                      position: "absolute",
                      left: cssLen(r.x),
                      top: cssLen(r.y),
                      width: cssLen(r.w),
                      height: cssLen(r.h),
                    }}
                    onClaude={launchClaude}
                    onSearch={() => palette?.show()}
                    onClose={() => tree && commit(closeSlot(tree, slot))}
                    onDrop={(tile) => place(tile, slot, "center")}
                  />
                ),
            )}
            {placed.gaps.map((g) => (
              <Border
                key={`${g.path.join(".")}/${g.k}`}
                gap={g}
                label={`${g.axis === "x" ? "Ancho" : "Alto"} entre las terminales ${nums(g.pair[0])} y ${nums(g.pair[1])}`}
                onSize={(next) => tree && commit(resizeSplit(tree, g.path, next))}
              />
            ))}
            {dragging &&
              !max &&
              (["left", "right", "top", "bottom"] as const).map((side) => (
                <Dock key={side} side={side} onDrop={(tile) => place(tile, null, side)} />
              ))}
          </div>
        </MesaTabs>
      </div>
    </MesaContext.Provider>
  );
}
