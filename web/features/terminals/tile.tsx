import {
  type CSSProperties,
  type DragEvent,
  lazy,
  type ReactNode,
  Suspense,
  useRef,
  useState,
} from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CrashBoundary } from "../../crash.tsx";
import { Icon } from "../../icons.tsx";
import { useRise } from "../../motion.ts";
import { SkeletonRows } from "../../ui.tsx";
import { ObjectiveChip } from "../objectives/chip.tsx";
import { JobView } from "../projects/job-tile.tsx";
import { findNode, type Projects, useProjects } from "../projects/queries.ts";
import { seen, useNeedsYou } from "./attention.tsx";
import { BRING_MIME, type BringItem, bringBlocked, decodeBring, PROMPT_MIME } from "./bring.ts";
import {
  codeLocation,
  dropSide,
  gitLocation,
  isCode,
  isJob,
  isRec,
  jobEnv,
  MAX_TILES,
  recId,
  type Side,
  TILE_MIME,
  type TileKind,
  tileKind,
} from "./grid-state.ts";
import { mesaTitle, useMesas } from "./mesas.ts";
import { phaseOf, shortPath, TERM_ICON } from "./panel.tsx";
import { useMesa } from "./place.ts";
import { openTerminalWindow, type TerminalInfo, terminalLabel, useTerminals } from "./queries.ts";
import { TurnReplies } from "./turn-replies.tsx";

// One tile of the Mesa and what names it: the terminal, git or job view inside its own crash
// boundary, the header that drags it, and the drop zones that split or swap it.

// xterm loads with the first tile, never with the picker; the git view with the first git
// tile, the code view (and its highlighter) with the first code tile.
const TerminalView = lazy(() => import("./window.tsx").then((m) => ({ default: m.TerminalView })));
const GitView = lazy(() => import("../git/tile.tsx").then((m) => ({ default: m.GitView })));
const RecView = lazy(() => import("../transcripts/tile.tsx").then((m) => ({ default: m.RecView })));
const CodeView = lazy(() => import("../code/tile.tsx").then((m) => ({ default: m.CodeView })));
const NO_BRING = "este panel no recibe tickets ni PR";

export const tileName = (t: TerminalInfo | undefined) =>
  t ? `${terminalLabel(t)} en ${shortPath(t.cwd)}` : "Terminal";

// A panel tile by what it shows: a checkout's git or code by its name in the tree, an env's
// output by the env, a recorded meeting as such.
export function panelName(p: Projects | undefined, id: string) {
  if (isJob(id)) return `Salida de ${jobEnv(id) ?? "un entorno"}`;
  if (isRec(id)) return "Reunión grabada";
  const location = isCode(id) ? codeLocation(id) : gitLocation(id);
  const name = (location && p && findNode(p, location)?.label) || location || "un checkout";
  return `${isCode(id) ? "Código" : "Git"} de ${name}`;
}

// Below 30rem (480px: still two tiles side by side next to the rail and a node at 1280) the
// Mesa drops its layout and stacks the tiles in reading order; the container query decides it as the browser lays out, with no measure.
const NARROW_FLOW = "@max-[30rem]:!static @max-[30rem]:!h-auto @max-[30rem]:!w-auto";

// What a tile dropped on another does, and the part of that tile it will take.
const DROP_TEXT: Record<Side | "center", string> = {
  left: "Soltar a la izquierda",
  right: "Soltar a la derecha",
  top: "Soltar arriba",
  bottom: "Soltar abajo",
  center: "Soltar para cambiarlas de sitio",
};
const DROP_AREA: Record<Side | "center", string> = {
  left: "inset-y-0 left-0 w-1/2",
  right: "inset-y-0 right-0 w-1/2",
  top: "inset-x-0 top-0 h-1/2",
  bottom: "inset-x-0 bottom-0 h-1/2",
  center: "inset-0",
};

// A tile whose view throws shows the Crash inside its own frame; its neighbours keep working.
export const tileBoundary = (view: TileKind, node: ReactNode) => (
  <CrashBoundary
    what={
      {
        git: "Git",
        job: "La salida",
        code: "El código",
        rec: "La reunión",
        terminal: "La terminal",
      }[view]
    }
  >
    {node}
  </CrashBoundary>
);

// One tile: the terminal itself, numbered for "Llevar a…", its header carrying the Mesa's own
// actions and, dragged, moving the tile. Another tile dropped near an edge splits this one;
// in the middle, they change places. A ticket or a PR dragged from the rail drops here too.
// A git tile is placed the same way and takes no ticket or PR.
export function Tile({
  id,
  n,
  maximized,
  focusSeq,
  dragging,
  style,
  onMax,
  onRemove,
  onOpen,
  onBring,
  onDrop,
  onSwap,
  onDrag,
}: {
  id: string;
  n: number;
  maximized: boolean;
  focusSeq?: number;
  // The tile being moved, so this one refuses a drop of itself.
  dragging: string | null;
  style?: CSSProperties;
  onMax: () => void;
  onRemove: () => void;
  onOpen: (t: TerminalInfo) => void;
  onBring: (item: BringItem) => void;
  onDrop: (tile: string, side: Side | "center") => void;
  onSwap: (step: number) => void;
  // Absent while the tile shows alone: there is nowhere to move it.
  onDrag?: (moving: boolean) => void;
}) {
  const all = useTerminals().data?.terminals ?? [];
  const info = all.find((t) => t.id === id);
  const view = tileKind(id);
  const panel = view !== "terminal";
  const projects = useProjects().data;
  const name = panel ? panelName(projects, id) : tileName(info);
  const blockedFor = (prompt: boolean) => (panel ? NO_BRING : bringBlocked(info, prompt));
  // Enter and leave fire for every child the drag crosses; the depth says when it is out.
  const depth = useRef(0);
  const [over, setOver] = useState<"bring" | "prompt" | Side | "center" | null>(null);
  const blocked = blockedFor(over === "prompt");
  // React bubbles a portal's events through its owner: a drag over the image picker is not
  // over this tile. Files from the system only light the tile: the terminal pastes them.
  const kind = (e: DragEvent) =>
    !(e.currentTarget as Node).contains(e.target as Node)
      ? null
      : e.dataTransfer.types.includes(TILE_MIME)
        ? "tile"
        : e.dataTransfer.types.includes(PROMPT_MIME)
          ? "prompt"
          : e.dataTransfer.types.includes(BRING_MIME)
            ? "bring"
            : e.dataTransfer.types.includes("Files")
              ? "files"
              : null;
  const out = () => {
    depth.current = 0;
    setOver(null);
  };
  const side = (e: DragEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return dropSide(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
  };
  const takesTile = n > 0 && dragging !== id;
  const refused = (over === "bring" || over === "prompt") && blocked;
  const needsYou = useNeedsYou(id);
  // The ring pulses again when the user comes back to the page (web/motion.ts).
  const rise = useRise(needsYou ? 1 : 0);
  const workspace = useMesas().workspace;
  const mesa = useMesa();
  const what = {
    git: "Git",
    job: "la salida",
    code: "el código",
    rec: "la reunión",
    terminal: "la terminal",
  }[view];
  const drag = onDrag && {
    onDragStart: (e: DragEvent<HTMLElement>) => {
      e.dataTransfer.setData(TILE_MIME, id);
      e.dataTransfer.effectAllowed = "move";
      onDrag(true);
    },
    onDragEnd: () => onDrag(false),
  };
  const lead =
    n > 0 ? (
      <button
        type="button"
        className="tile-num"
        aria-label={`Mover ${what} ${n}`}
        title="Arrastra la cabecera para moverla; ← → la cambian de sitio"
        onKeyDown={(e) => {
          const step = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
          if (!step) return;
          e.preventDefault();
          onSwap(step);
        }}
      >
        {n}
      </button>
    ) : (
      <span className="tile-num" title="Fuera de la cuadrícula: la Mesa está llena">
        ·
      </span>
    );
  const maxButton = (
    <button
      type="button"
      className={TERM_ICON}
      aria-label={maximized ? "Volver a la cuadrícula" : "Ampliar"}
      title={maximized ? "Volver a la cuadrícula" : "Ampliar"}
      onClick={onMax}
    >
      <Icon name={maximized ? "restore" : "maximize"} size={14} />
    </button>
  );
  const removeButton = (
    <button
      type="button"
      className={TERM_ICON}
      aria-label={`Quitar ${name} de la cuadrícula`}
      title={panel ? "Quitar de la cuadrícula" : "Quitar de la cuadrícula (sigue en marcha)"}
      onClick={onRemove}
    >
      <Icon name="close" size={14} />
    </button>
  );
  return (
    <section
      aria-label={name}
      data-harness={
        { git: "git", job: "env", code: "code", rec: "rec", terminal: info?.harness }[view]
      }
      {...(view === "git"
        ? { "data-git-tile": gitLocation(id) ?? "" }
        : view === "job"
          ? { "data-job-tile": jobEnv(id) ?? "" }
          : view === "code"
            ? { "data-code-tile": codeLocation(id) ?? "" }
            : view === "rec"
              ? { "data-rec-tile": recId(id) ?? "" }
              : { "data-terminal-id": id })}
      style={
        view === "terminal" && info
          ? ({ ...style, "--phase": phaseOf(info).color } as CSSProperties)
          : style
      }
      onPointerDownCapture={() => seen(id)}
      onFocusCapture={() => seen(id)}
      className={`tile group/tile ${NARROW_FLOW} relative min-h-0 overflow-hidden ${
        over ? (refused ? "border-bad" : "border-primary ring-2 ring-primary") : ""
      }`}
      onDragEnterCapture={(e) => {
        const k = kind(e);
        if (!k) return;
        depth.current += 1;
        if (k === "bring" || k === "files") setOver("bring");
        if (k === "prompt") setOver("prompt");
      }}
      onDragLeaveCapture={(e) => {
        if (!kind(e)) return;
        depth.current -= 1;
        if (depth.current <= 0) out();
      }}
      // Only a drop this tile can take is allowed; xterm's textarea never sees it. A bar
      // button drops even when refused, so the notice says why.
      onDragOverCapture={(e) => {
        const k = kind(e);
        const no = k === "bring" || k === "files" ? blockedFor(false) : null;
        if (!k || no || (k === "tile" && !takesTile) || (k === "prompt" && panel)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = k === "tile" ? "move" : "copy";
        if (k === "tile") setOver(side(e));
      }}
      onDropCapture={(e) => {
        const k = kind(e);
        if (!k) return;
        if (k === "files") return out();
        e.preventDefault();
        e.stopPropagation();
        out();
        if (k === "tile") {
          const tile = e.dataTransfer.getData(TILE_MIME);
          if (tile && takesTile) onDrop(tile, side(e));
          return;
        }
        if (k === "prompt") {
          const item = panel ? null : decodeBring(e.dataTransfer.getData(BRING_MIME));
          if (item && "prompt" in item) onBring(item);
          return;
        }
        const item = blockedFor(false) ? null : decodeBring(e.dataTransfer.getData(BRING_MIME));
        if (item && !("prompt" in item)) onBring(item);
      }}
    >
      {tileBoundary(
        view,
        <Suspense fallback={<SkeletonRows count={1} />}>
          {view === "git" ? (
            <GitView
              location={gitLocation(id)}
              drag={drag}
              lead={lead}
              actions={
                <>
                  {maxButton}
                  {removeButton}
                </>
              }
            />
          ) : view === "code" ? (
            <CodeView
              location={codeLocation(id)}
              drag={drag}
              lead={lead}
              actions={
                <>
                  {maxButton}
                  {removeButton}
                </>
              }
            />
          ) : view === "rec" ? (
            <RecView
              recording={recId(id)}
              drag={drag}
              lead={lead}
              actions={
                <>
                  {maxButton}
                  {removeButton}
                </>
              }
            />
          ) : view === "job" ? (
            <JobView
              env={jobEnv(id)}
              drag={drag}
              lead={lead}
              actions={
                <>
                  {maxButton}
                  {removeButton}
                </>
              }
            />
          ) : (
            <TerminalView
              id={id}
              autoFocus={false}
              onOpen={onOpen}
              focusSeq={focusSeq}
              drag={drag}
              lead={lead}
              overlay={
                info && (
                  <TurnReplies
                    t={info}
                    className={`absolute top-2 right-3 z-[5] max-w-[calc(100%-1.5rem)] transition-opacity duration-120 ease-out focus-within:opacity-100 group-hover/tile:opacity-100 [@media(hover:none)]:opacity-100 ${needsYou ? "" : "opacity-0"}`}
                  />
                )
              }
              actions={
                <>
                  {info && info.harness !== "env" && <ObjectiveChip t={info} />}
                  {workspace.mesas.length > 1 && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className={TERM_ICON}
                          aria-label="Mover a otra Mesa"
                          title="Mover a otra Mesa"
                        >
                          <Icon name="mesa" size={14} />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {workspace.mesas
                          .filter((m) => m.id !== mesa?.id)
                          .map((m) => (
                            <DropdownMenuItem
                              key={m.id}
                              disabled={m.ids.length >= MAX_TILES}
                              onSelect={() => mesa?.move?.(id, m.id)}
                            >
                              {mesaTitle(m, all)}
                              {m.ids.length >= MAX_TILES ? " · llena" : ""}
                            </DropdownMenuItem>
                          ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                  <button
                    type="button"
                    className={TERM_ICON}
                    aria-label="Ventana aparte"
                    title="Ventana aparte"
                    onClick={() => openTerminalWindow(id)}
                  >
                    <Icon name="external" size={14} />
                  </button>
                </>
              }
              pinned={
                <>
                  {maxButton}
                  {removeButton}
                </>
              }
            />
          )}
        </Suspense>,
      )}
      {/* Waiting for the user (attention.tsx): a blinking ring in its phase's colour (a question
          amber, a finished turn green, a failure red) until the tile is clicked or focused. */}
      {needsYou && (
        <div
          key={rise}
          aria-hidden
          data-part="attention"
          className="pointer-events-none absolute inset-0 z-10 shadow-[inset_0_0_0_2px_var(--phase,var(--warn))] motion-safe:animate-attention"
        />
      )}
      {over === "bring" || over === "prompt" ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-black/30"
        >
          <span className="rounded-md bg-panel px-3 py-1.5 font-medium text-[13px] text-ink shadow-lg">
            {refused
              ? `No se puede: ${blocked}`
              : over === "prompt"
                ? "Soltar para enviar aquí"
                : "Soltar para llevar aquí"}
          </span>
        </div>
      ) : (
        over && (
          <div aria-hidden className="pointer-events-none absolute inset-0 z-10 bg-black/20">
            <div
              className={`absolute ${DROP_AREA[over]} grid place-items-center bg-primary/25 ring-2 ring-primary ring-inset`}
            >
              <span className="rounded-md bg-panel px-3 py-1.5 font-medium text-[13px] text-ink shadow-lg">
                {DROP_TEXT[over]}
              </span>
            </div>
          </div>
        )
      )}
    </section>
  );
}
