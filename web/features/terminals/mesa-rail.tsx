import { type KeyboardEvent, type PointerEvent, type ReactNode, useRef, useState } from "react";
import { z } from "zod";
import { Icon } from "../../icons.tsx";
import { storageFamily } from "../../storage.ts";

// The Mesa's rail, on its left: the Mesas over the projects, tickets and PRs. Its folding and
// its width are kept in this browser.

// A rail's width, dragged by its inner edge. Kept per rail in this browser; none kept means the
// default for the screen (the classes in `Rail`). Never so wide that the Mesa loses its tiles.
export const RAIL_MIN = 240;
const RAIL_STEP = 16;
// The only cap is the window's 45 %, so a wide screen can give a rail real room.
export const railWidth = (w: number, view: number) =>
  Math.round(Math.max(RAIL_MIN, Math.min(w, view * 0.45)));
// 0: none kept.
export const railWidths = storageFamily("aos.rail-width:", {
  schema: z.coerce.number().positive(),
  fallback: 0,
  legacy: (id) => `rail-width:${id}`,
});

// The width shown, set live while dragging, and `keep` to remember it (null: the default).
function useRailWidth(id: string) {
  const [width, setWidth] = useState(() => railWidths.get(id) || null);
  const keep = (w: number | null) => {
    setWidth(w);
    if (w === null) railWidths.remove(id);
    else railWidths.set(id, w);
  };
  return [width, setWidth, keep] as const;
}

// The rail's inner edge: the ARIA window splitter, like the borders between tiles.
function RailEdge({
  controls,
  name,
  width,
  onMove,
  onKeep,
}: {
  controls: string;
  name: string;
  // The width in effect, measured when none is kept.
  width: () => number;
  onMove: (w: number) => void;
  onKeep: (w: number | null) => void;
}) {
  const drag = useRef<{ x: number; w: number; moved: boolean } | null>(null);
  const of = name.startsWith("el ") ? `del ${name.slice(3)}` : `de ${name}`;
  const [now, setNow] = useState<number | null>(null);
  // Dragging right widens the rail.
  const to = (e: PointerEvent, d: { x: number; w: number }) =>
    railWidth(d.w + e.clientX - d.x, window.innerWidth);
  const reset = () => {
    onKeep(null);
    setNow(null);
  };
  const key = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home") return;
    e.preventDefault();
    if (e.key === "Home") return reset();
    const step = e.key === "ArrowRight" ? RAIL_STEP : -RAIL_STEP;
    const next = railWidth(width() + step, window.innerWidth);
    setNow(next);
    onKeep(next);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot take focus or a drag; this is the ARIA window splitter.
    <div
      role="separator"
      tabIndex={0}
      aria-label={`Ancho ${of}`}
      aria-controls={controls}
      aria-orientation="vertical"
      aria-valuemin={RAIL_MIN}
      aria-valuemax={
        typeof window === "undefined"
          ? undefined
          : railWidth(Number.POSITIVE_INFINITY, window.innerWidth)
      }
      aria-valuenow={now ?? undefined}
      title={`Ancho ${of} · doble clic: medida inicial`}
      className="group absolute inset-y-0 -right-1.5 z-20 flex w-3 cursor-col-resize touch-none justify-center outline-none"
      onFocus={() => setNow(Math.round(width()))}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, w: width(), moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.moved = true;
        const next = to(e, d);
        setNow(next);
        onMove(next);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (d?.moved) onKeep(to(e, d));
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onDoubleClick={reset}
      onKeyDown={key}
    >
      <span
        aria-hidden
        className="h-full w-0.5 rounded-full bg-primary opacity-0 transition-opacity group-hover:opacity-60 group-focus-visible:opacity-100 group-active:opacity-100"
      />
      {/* At rest a grip on the border says it can be dragged; the bar takes over when used. */}
      <span
        aria-hidden
        className="drag-grip absolute top-1/2 h-7 -translate-y-1/2 rounded-sm bg-panel transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0 group-active:opacity-0"
      />
    </div>
  );
}

// The rail. Open, `head` and the tools over its body; folded, a strip with the button that
// opens it again. `tools` (the layout presets) sit in its head, and stack in the strip.
export function Rail({
  id,
  label,
  name,
  open,
  onToggle,
  head,
  tools,
  foot,
  children,
}: {
  id: string;
  label: string;
  // What the toggle shows or hides: "el carril".
  name: string;
  open: boolean;
  onToggle: () => void;
  head: ReactNode;
  tools?: (vertical: boolean) => ReactNode;
  // Under the body, open or folded: the shelf of draft images.
  foot?: (vertical: boolean) => ReactNode;
  children: ReactNode;
}) {
  const verb = open ? "Ocultar" : "Mostrar";
  const [width, setWidth, keepWidth] = useRailWidth(id);
  const section = useRef<HTMLElement>(null);
  const toggle = (
    <button
      type="button"
      className="btn-ghost shrink-0 justify-center"
      aria-expanded={open}
      aria-controls={id}
      aria-label={`${verb} ${name}`}
      title={`${verb} ${name}`}
      onClick={onToggle}
    >
      <Icon name={open ? "railClose" : "railOpen"} size={14} />
    </button>
  );
  if (!open)
    return (
      <div className="hidden w-9 shrink-0 flex-col items-center gap-1 border-line border-r bg-panel py-1.5 md:flex">
        {toggle}
        {tools?.(true)}
        {foot?.(true)}
      </div>
    );
  return (
    <section
      ref={section}
      id={id}
      aria-label={label}
      className={`relative hidden min-h-0 shrink-0 flex-col border-line border-r bg-panel md:flex ${width !== null ? "" : "w-[340px]"}`}
      // The cap follows the window, so a width kept on a wide screen still fits a narrow one.
      style={width !== null ? { width, maxWidth: "45vw", minWidth: RAIL_MIN } : undefined}
    >
      <RailEdge
        controls={id}
        name={name}
        width={() => section.current?.getBoundingClientRect().width ?? width ?? RAIL_MIN}
        onMove={setWidth}
        onKeep={keepWidth}
      />
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-0.5">{head}</div>
        <span className="flex shrink-0 items-center gap-0.5">
          {tools?.(false)}
          {toggle}
        </span>
      </div>
      {/* Positioned, so it clips what is absolute inside it too (the cards' sr-only text):
          otherwise that text hangs off the section below the window and the page scrolls. */}
      <div className="relative flex min-h-0 flex-1 flex-col">{children}</div>
      {foot?.(false)}
    </section>
  );
}

// A segmented control's button: the rail's sources, the Mesa page's views.
export const SEGMENT =
  "flex h-6 items-center gap-1.5 rounded px-2 text-[12px] text-ink-2 hover:text-ink aria-pressed:bg-[var(--selected)] aria-pressed:font-medium aria-pressed:text-ink";
