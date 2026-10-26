import { type CSSProperties, type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import { Icon, type IconName } from "../../icons.tsx";
import { shortcut } from "../../keys.ts";
import {
  cssLen,
  even,
  floors,
  type Gap,
  lenAt,
  moveBorder,
  type Preset,
  plus,
  type Side,
  TILE_MIME,
  times,
} from "./grid-state.ts";
import { TERM_ICON } from "./panel.tsx";

// The parts of a Mesa's layout around its tiles: the borders between splits, the docks along
// its sides while a tile moves, the empty slots a preset leaves, and the presets themselves.

// Below 30rem the Mesa stacks its tiles (tile.tsx NARROW_FLOW); these parts then hide.
export const NARROW_HIDDEN = "@max-[30rem]:hidden";

// The grid's padding and gap (p-3, gap-3), which the borders sit between.
export const PAD = 12;
export const GAP = 12;
const STEP = 0.05;

// A draggable border between two kids of one split. While dragged only its line moves; the
// tiles take the new size on release, so each terminal is resized once, not on every frame.
export function Border({
  gap,
  label,
  onSize,
}: {
  gap: Gap;
  label: string;
  onSize: (next: number[]) => void;
}) {
  const { axis, k, sizes, at } = gap;
  const [preview, setPreview] = useState<number[] | null>(null);
  // The drag lives in a ref: a release can come before the last move has rendered, so it
  // measures again from where the pointer is. `room` is the split's room in pixels.
  const drag = useRef<{ at: number; room: number } | null>(null);
  const shown = preview ?? sizes;
  const before = shown.slice(0, k + 1).reduce((a, b) => a + b, 0);
  const shift = times(gap.room, (shown[k] ?? 0) - (sizes[k] ?? 0));
  // The split's room, measured on the Mesa only when the border is used.
  const roomOf = (el: HTMLElement) => {
    const box = el.parentElement?.getBoundingClientRect();
    return box ? lenAt(gap.room, axis === "x" ? box.width : box.height) : 0;
  };
  const moved = (delta: number, room: number) => moveBorder(sizes, k, delta, floors(gap, room));
  const point = (e: PointerEvent) => (axis === "x" ? e.clientX : e.clientY);
  const key = (e: KeyboardEvent<HTMLElement>) => {
    const back = axis === "x" ? "ArrowLeft" : "ArrowUp";
    const fwd = axis === "x" ? "ArrowRight" : "ArrowDown";
    if (e.key !== back && e.key !== fwd && e.key !== "Home") return;
    e.preventDefault();
    onSize(
      e.key === "Home"
        ? even(sizes.length)
        : moved(e.key === fwd ? STEP : -STEP, roomOf(e.currentTarget)),
    );
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot take focus or a drag; this is the ARIA window splitter.
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(before * 100)}
      title={`${label}: arrastra, o usa las flechas; doble clic o Inicio los iguala`}
      className={`group absolute z-20 flex touch-none items-center justify-center outline-none ${NARROW_HIDDEN} ${
        axis === "x" ? "cursor-col-resize" : "cursor-row-resize"
      }`}
      style={{
        left: cssLen(axis === "x" ? plus(at.x, shift) : at.x),
        top: cssLen(axis === "y" ? plus(at.y, shift) : at.y),
        width: cssLen(at.w),
        height: cssLen(at.h),
      }}
      onPointerDown={(e) => {
        const room = roomOf(e.currentTarget);
        if (room <= 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { at: point(e), room };
        setPreview(sizes);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        setPreview(moved((point(e) - d.at) / d.room, d.room));
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        if (d) onSize(moved((point(e) - d.at) / d.room, d.room));
        drag.current = null;
        setPreview(null);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setPreview(null);
      }}
      onDoubleClick={() => onSize(even(sizes.length))}
      onKeyDown={key}
    >
      <span
        aria-hidden
        className={`rounded-full bg-primary transition-opacity ${
          preview
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-60 group-focus-visible:opacity-100"
        } ${axis === "x" ? "h-full w-0.5" : "h-0.5 w-full"}`}
      />
    </div>
  );
}

// A strip along one side of the Mesa while a tile is moved: dropped there, the tile runs along
// the whole side.
const DOCK_AREA: Record<Side, string> = {
  left: "inset-y-0 left-0 w-6",
  right: "inset-y-0 right-0 w-6",
  top: "inset-x-0 top-0 h-6",
  bottom: "inset-x-0 bottom-0 h-6",
};

export function Dock({ side, onDrop }: { side: Side; onDrop: (tile: string, side: Side) => void }) {
  const [over, setOver] = useState(false);
  return (
    <div
      aria-hidden
      data-dock={side}
      className={`absolute z-40 ${NARROW_HIDDEN} ${DOCK_AREA[side]} ${over ? "bg-primary/50" : "bg-primary/15"}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(TILE_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const tile = e.dataTransfer.getData(TILE_MIME);
        if (tile) onDrop(tile, side);
      }}
    />
  );
}

// An empty place a preset left: it takes the next terminal added (a new Claude, or one found
// with the search), or a tile dropped on it.
export function Slot({
  style,
  dragging,
  onClaude,
  onSearch,
  onClose,
  onDrop,
}: {
  style: CSSProperties;
  dragging: string | null;
  onClaude: () => void;
  onSearch: () => void;
  onClose: () => void;
  onDrop: (tile: string) => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <section
      aria-label="Hueco libre"
      style={style}
      className={`${NARROW_HIDDEN} grid place-items-center rounded-lg border-2 border-dashed ${
        over ? "border-primary bg-primary/10" : "border-line"
      }`}
      onDragOver={(e) => {
        if (!dragging || !e.dataTransfer.types.includes(TILE_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const tile = e.dataTransfer.getData(TILE_MIME);
        if (tile) onDrop(tile);
      }}
    >
      <span className="flex flex-wrap justify-center gap-2">
        <button
          type="button"
          className="btn gap-1.5"
          title="Claude en la carpeta libre"
          onClick={onClaude}
        >
          <Icon name="plus" size={14} />
          Claude
        </button>
        <button
          type="button"
          className="btn-ghost gap-1.5"
          title={`Buscar una terminal abierta (${shortcut("K")})`}
          onClick={onSearch}
        >
          <Icon name="search" size={14} />
          Buscar terminal…
        </button>
      </span>
      <button
        type="button"
        className={`${TERM_ICON} absolute top-1.5 right-1.5`}
        aria-label="Cerrar el hueco"
        title="Cerrar el hueco"
        onClick={onClose}
      >
        <Icon name="close" size={14} />
      </button>
    </section>
  );
}

export const PRESETS: { id: Preset; label: string; icon: IconName }[] = [
  { id: "columns", label: "Columnas", icon: "columns" },
  { id: "grid", label: "Cuadrícula", icon: "grid" },
  { id: "main", label: "Principal", icon: "main" },
];
