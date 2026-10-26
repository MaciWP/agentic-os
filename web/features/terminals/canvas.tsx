import {
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { relativeTime } from "../../format.ts";
import { Icon } from "../../icons.tsx";
import { createStore, useStore } from "../../store.ts";
import { ProjectTag } from "../projects/project-tag.tsx";
import { arrowFocus } from "./arrow-focus.ts";
import {
  type Camera,
  type CanvasLayout,
  canvasLayout,
  clampZoom,
  type Detail,
  detailAt,
  fit,
  reveal,
  zoomAt,
} from "./canvas-layout.ts";
import { isPanel } from "./grid-state.ts";
import { HarnessLogo } from "./logos.tsx";
import { byBlock } from "./mesa-blocks.ts";
import { MesaStatus, type MesaSummary } from "./mesa-view.tsx";
import type { Workspace } from "./mesas.ts";
import { phaseOf, rowText, shortPath, standingOf, WaitPill, waitColor } from "./panel.tsx";
import { kindLabel, type TerminalInfo } from "./queries.ts";
import { TurnReplies } from "./turn-replies.tsx";

// The Lienzo's camera, kept while the page lives, so «Volver» finds it where it was. null:
// fit everything, and keep fitting as the window changes, until the user moves it.
const camera = createStore<Camera | null>(null);
const STEP = 1.25;

const FRAME_REST =
  "border-[color-mix(in_oklab,var(--line)_80%,transparent)] bg-[color-mix(in_oklab,var(--panel)_70%,transparent)]";
const FRAME_WAITS =
  "border-[color-mix(in_oklab,var(--kc)_55%,transparent)] bg-[color-mix(in_oklab,var(--kc)_6%,var(--panel))]";
const CARD_REST = "border-line bg-[var(--panel)]";
const CARD_WAITS =
  "border-[color-mix(in_oklab,var(--kc)_65%,transparent)] bg-[color-mix(in_oklab,var(--kc)_10%,var(--panel))]";

// Every terminal of every Mesa as a card on one canvas: a band per block, a frame per Mesa.
// Drag the background to move, ⌘ or a pinch with the wheel to zoom, ⇧1 to fit everything.
// The cards are text, never live terminals: a page holds only so many.
export function Canvas({
  summaries,
  workspace,
  terminals,
  waiting,
  placeOf,
  onOpen,
}: {
  summaries: MesaSummary[];
  workspace: Workspace;
  terminals: TerminalInfo[];
  waiting: ReadonlySet<string>;
  placeOf: Map<string, { label: string }>;
  onOpen: (mesa: string, tile?: string) => void;
}) {
  const bands = byBlock(summaries, workspace);
  const byId = new Map(terminals.map((t) => [t.id, t]));
  const layout = canvasLayout(
    bands.map((b) => ({
      key: b.key,
      mesas: b.items.map((v) => ({
        id: v.mesa.id,
        cards: v.mesa.ids.filter((id) => !isPanel(id) && byId.has(id)),
      })),
    })),
  );
  const viewport = useRef<HTMLElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const kept = useStore(camera);
  const view = kept ?? fit(layout, size);
  // What the native listeners read: the camera in effect now.
  const now = useRef({ view, layout, size });
  now.current = { view, layout, size };
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // React's wheel listener is passive: the page would zoom or scroll instead of the canvas.
  // A pinch arrives as a wheel with ctrlKey.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const c = now.current.view;
      const r = el.getBoundingClientRect();
      camera.set(
        e.ctrlKey || e.metaKey
          ? zoomAt(c, c.z * Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top)
          : { ...c, x: c.x - e.deltaX, y: c.y - e.deltaY },
      );
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  const zoomBy = (factor: number) =>
    camera.set(zoomAt(view, clampZoom(view.z * factor), size.w / 2, size.h / 2));
  const rectOf = (el: HTMLElement) => {
    const id = el.dataset.card ?? el.dataset.frame;
    return (
      layout.cards.find((c) => c.id === el.dataset.card) ??
      layout.frames.find((f) => f.id === id) ??
      null
    );
  };
  // A card reached by the keyboard comes into sight by moving the camera, never by the
  // browser scrolling the viewport (which would shift everything under the camera).
  const bringIn = (el: HTMLElement) => {
    const r = rectOf(el);
    if (r) camera.set(reveal(view, el.dataset.card ? r : { ...r, h: 36 }, size));
  };
  const keys = (e: KeyboardEvent<HTMLElement>) => {
    if (e.shiftKey && e.code === "Digit1") {
      e.preventDefault();
      return camera.set(null);
    }
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      return zoomBy(STEP);
    }
    if (e.key === "-") {
      e.preventDefault();
      return zoomBy(1 / STEP);
    }
    arrowFocus(e, "[data-card],[data-frame]", (el) => {
      el.focus({ preventScroll: true });
      bringIn(el);
    });
  };
  const focused = (e: FocusEvent<HTMLElement>) => {
    const el = viewport.current;
    if (el) el.scrollTo(0, 0);
    bringIn(e.target as HTMLElement);
  };

  // Dragging the background moves the camera.
  const drag = useRef<{ x: number; y: number; from: Camera } | null>(null);
  const down = (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, from: view };
  };
  const moveTo = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (d) camera.set({ ...d.from, x: d.from.x + e.clientX - d.x, y: d.from.y + e.clientY - d.y });
  };

  const detail = detailAt(view.z);
  const summaryOf = new Map(summaries.map((v) => [v.mesa.id, v]));
  const bandOf = new Map(bands.map((b) => [b.key, b]));
  return (
    <section
      ref={viewport}
      aria-label="Lienzo de las Mesas"
      data-detail={detail}
      className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden bg-[var(--bg)] active:cursor-grabbing"
      style={{
        backgroundImage:
          "radial-gradient(color-mix(in oklab, var(--ink) 16%, transparent) 1px, transparent 1px)",
        backgroundSize: `${24 * view.z}px ${24 * view.z}px`,
        backgroundPosition: `${view.x}px ${view.y}px`,
      }}
      onKeyDown={keys}
      onFocus={focused}
      onScroll={(e) => e.currentTarget.scrollTo(0, 0)}
      onPointerDown={down}
      onPointerMove={moveTo}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    >
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{
          width: layout.w,
          height: layout.h,
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`,
        }}
      >
        {layout.bands.map((b) => {
          const band = bandOf.get(b.key);
          return (
            <h2
              key={b.key || "none"}
              className="absolute flex items-center gap-2 font-semibold text-ink-2"
              style={{ left: b.x, top: b.y, fontSize: detail === "far" ? 30 : 15 }}
            >
              <span
                aria-hidden
                data-block={band?.color ?? undefined}
                className={`size-[0.6em] rounded-full ${band?.color ? "bg-[var(--blk)]" : "border border-line"}`}
              />
              {band?.name}
            </h2>
          );
        })}
        {layout.frames.map((f) => {
          const v = summaryOf.get(f.id);
          return v ? (
            <Frame
              key={f.id}
              v={v}
              rect={f}
              detail={detail}
              open={f.id === workspace.activeId}
              onOpen={onOpen}
            />
          ) : null;
        })}
        {layout.cards.map((c) => {
          const t = byId.get(c.id);
          const v = summaryOf.get(c.mesa);
          return t && v ? (
            <Card
              key={c.id}
              t={t}
              mesa={v}
              rect={c}
              detail={detail}
              waiting={waiting}
              place={placeOf.get(t.id)?.label ?? shortPath(t.cwd)}
              onOpen={onOpen}
            />
          ) : null;
        })}
      </div>
      <fieldset
        aria-label="Zoom del lienzo"
        className="absolute right-3 bottom-3 flex items-center gap-0.5 rounded-lg border border-line bg-[var(--panel)] p-0.5 text-[12px] shadow-sm"
      >
        <button
          type="button"
          className="btn-ghost size-7 justify-center p-0"
          aria-label="Alejar"
          title="Alejar (−)"
          onClick={() => zoomBy(1 / STEP)}
        >
          <Icon name="minus" size={14} />
        </button>
        <output aria-live="off" className="w-11 text-center text-ink-2 tabular-nums">
          {Math.round(view.z * 100)} %
        </output>
        <button
          type="button"
          className="btn-ghost size-7 justify-center p-0"
          aria-label="Acercar"
          title="Acercar (+)"
          onClick={() => zoomBy(STEP)}
        >
          <Icon name="plus" size={14} />
        </button>
        <button
          type="button"
          className="btn-ghost h-7 gap-1.5 px-2"
          onClick={() => camera.set(null)}
        >
          Encajar
          <kbd className="text-[11px] text-ink-2">⇧1</kbd>
        </button>
      </fieldset>
    </section>
  );
}

// A Mesa's frame around its cards; its title opens the Mesa.
function Frame({
  v,
  rect,
  detail,
  open,
  onOpen,
}: {
  v: MesaSummary;
  rect: CanvasLayout["frames"][number];
  detail: Detail;
  open: boolean;
  onOpen: (mesa: string) => void;
}) {
  const panels = v.mesa.ids.filter(isPanel).length;
  const empty = !v.mesa.ids.some((id) => !isPanel(id));
  return (
    <div
      data-wait={v.loud ?? undefined}
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        ...(v.loud && ({ "--kc": waitColor(v.loud) } as CSSProperties)),
      }}
      className={`absolute rounded-[14px] border ${v.loud ? FRAME_WAITS : FRAME_REST} ${open ? "ring-2 ring-[var(--accent)]" : ""}`}
    >
      <button
        type="button"
        data-frame={v.mesa.id}
        aria-current={open || undefined}
        title={v.hover}
        onClick={() => onOpen(v.mesa.id)}
        className="flex h-9 w-full min-w-0 items-center gap-1.5 rounded-t-[14px] px-3 text-left hover:bg-[var(--hover)]"
        style={detail === "far" ? { fontSize: 26, height: 36 } : undefined}
      >
        {v.icon && <span aria-hidden>{v.icon}</span>}
        {v.badge && <span className="pill h-4 shrink-0 px-1 font-mono text-[10px]">{v.badge}</span>}
        <span className={`min-w-0 truncate font-semibold ${detail === "far" ? "" : "text-[13px]"}`}>
          {v.text || v.label}
        </span>
        {detail !== "far" && v.project && <ProjectTag name={v.project} className="max-w-32" />}
        {detail !== "far" && <MesaStatus v={v} wide />}
        {detail !== "far" && panels > 0 && (
          <span className="shrink-0 text-[11px] text-ink-2">
            +{panels} {panels === 1 ? "panel" : "paneles"}
          </span>
        )}
      </button>
      {empty && (
        <p
          className="px-3 pt-2 text-[12px] text-ink-2"
          style={detail === "far" ? { fontSize: 22 } : undefined}
        >
          Sin terminales
        </p>
      )}
    </div>
  );
}

// A terminal as a card. Far: its harness and name, big enough to read. Mid: also where it
// stands, its task and its last words. Near: also what it asks and where it works.
function Card({
  t,
  mesa,
  rect,
  detail,
  waiting,
  place,
  onOpen,
}: {
  t: TerminalInfo;
  mesa: MesaSummary;
  rect: CanvasLayout["cards"][number];
  detail: Detail;
  waiting: ReadonlySet<string>;
  place: string;
  onOpen: (mesa: string, tile?: string) => void;
}) {
  const phase = phaseOf(t);
  const s = standingOf(t, waiting);
  const loud = s.group === "waits" && !s.seen ? s.kind : null;
  const name = rowText(t);
  const task = t.agent?.title && t.agent.title !== name ? t.agent.title : t.agent?.prompt;
  const at = t.lastOutputAt ?? t.endedAt ?? t.startedAt;
  return (
    // The replies sit beside the card's button, never inside it: a button holds no buttons.
    <div
      data-wait={loud ?? undefined}
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        ...(loud && ({ "--kc": waitColor(loud) } as CSSProperties)),
      }}
      className={`absolute overflow-hidden rounded-[10px] border shadow-[0_1px_2px_rgb(0_0_0/0.12)] hover:border-[var(--accent)] ${loud ? CARD_WAITS : CARD_REST}`}
    >
      <button
        type="button"
        data-card={t.id}
        aria-label={`${name} · ${kindLabel(t)} · ${phase.label} · ${mesa.label}`}
        title={`${name}\n${kindLabel(t)} · ${phase.label}\n${place}`}
        onClick={() => onOpen(mesa.mesa.id, t.id)}
        className="flex size-full flex-col gap-1 rounded-[9px] p-2.5 text-left"
      >
        {detail === "far" ? (
          <span className="flex min-w-0 flex-1 items-center gap-3">
            <HarnessLogo kind={t.harness} size={40} />
            <span className="line-clamp-2 min-w-0 font-semibold text-[26px] leading-tight">
              {name}
            </span>
          </span>
        ) : (
          <>
            <span className="flex min-w-0 items-center gap-1.5">
              <HarnessLogo kind={t.harness} size={13} />
              <span className="min-w-0 truncate font-medium text-[13px]">{name}</span>
              <span className="ml-auto shrink-0">
                {loud ? (
                  <WaitPill kind={loud} wide />
                ) : (
                  <span className={`text-[11px] ${phase.text}`}>{phase.label}</span>
                )}
              </span>
            </span>
            {detail === "near" && t.agent?.question ? (
              <span className="line-clamp-3 text-[12px] text-warn leading-snug">
                {t.agent.question}
              </span>
            ) : (
              <>
                {task && <span className="truncate text-[12px] text-ink-2">{task}</span>}
                {t.agent?.lastMessage && (
                  <span className="line-clamp-2 font-mono text-[11px] text-ink/80 leading-snug">
                    ❯ {t.agent.lastMessage}
                  </span>
                )}
              </>
            )}
            <span className="mt-auto flex min-w-0 items-center gap-1.5 text-[11px] text-ink-2">
              {detail === "near" && <span className="min-w-0 truncate">{place}</span>}
              <span className="ml-auto shrink-0">{at ? relativeTime(at) : ""}</span>
            </span>
          </>
        )}
      </button>
      {/* Near, a finished turn takes its reply here, over the card's foot. */}
      {detail === "near" && (
        <TurnReplies
          t={t}
          limit={2}
          className="absolute inset-x-0 bottom-0 bg-inherit px-2 pt-1 pb-2"
        />
      )}
    </div>
  );
}
