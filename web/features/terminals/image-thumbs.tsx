import { type DragEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { ImageItem } from "../../../server/features/images/store.ts";
import { byteSize, relativeTime } from "../../format.ts";
import { Icon } from "../../icons.tsx";
import { machineUrl } from "../../machine.ts";

// The image history's pieces for one image: a thumbnail of the grid and the large preview.

const imageUrl = (id: string) => machineUrl(`/api/images/${encodeURIComponent(id)}`);
const SOURCE: Record<ImageItem["source"], string> = {
  pasted: "Pegada",
  captured: "Capturada",
  folder: "Carpeta",
};
const MINI =
  "grid size-6 place-items-center rounded bg-black/70 text-white/85 ring-1 ring-white/15 hover:text-white";
export const plain = (e: KeyboardEvent) => !e.metaKey && !e.ctrlKey && !e.altKey;
export const isDelete = (e: KeyboardEvent) => e.key === "Delete" || e.key === "Backspace";

// One thumbnail of the grid: a click marks it, a double click shows it large.
export function ImageThumb({
  item,
  n,
  armed,
  onToggle,
  onPreview,
  onErase,
  onDrag,
}: {
  item: ImageItem;
  n: number;
  armed: boolean;
  onToggle: () => void;
  onPreview: () => void;
  onErase: () => void;
  onDrag: (e: DragEvent<HTMLElement>) => void;
}) {
  const when = relativeTime(new Date(item.mtime).toISOString());
  return (
    <div className="group relative">
      <button
        type="button"
        data-thumb={item.id}
        draggable
        aria-pressed={n > 0}
        aria-label={`${SOURCE[item.source]}, ${when}: ${item.name}`}
        title={`${item.name} · ${byteSize(item.bytes)}`}
        onClick={onToggle}
        onDoubleClick={onPreview}
        onDragStart={onDrag}
        className={`relative block aspect-[4/3] w-full cursor-grab overflow-hidden rounded border bg-black/30 focus-visible:outline-2 focus-visible:outline-term-accent ${
          n > 0 ? "border-term-accent ring-2 ring-term-accent" : "border-white/10"
        }`}
      >
        <img
          src={imageUrl(item.id)}
          alt=""
          loading="lazy"
          draggable={false}
          className="size-full object-cover"
        />
        {n > 0 && (
          <span className="absolute top-1 right-1 grid size-5 place-items-center rounded-full bg-term-accent font-semibold text-[11px] text-white">
            {n}
          </span>
        )}
        <span className="absolute inset-x-0 bottom-0 truncate bg-black/65 px-1 text-left text-[10px] text-white/80">
          {SOURCE[item.source]} · {when}
        </span>
        {armed && (
          <span className="absolute inset-0 grid place-items-center bg-bad/75 px-1 text-center font-medium text-[11px] text-white">
            Pulsa otra vez para borrar
          </span>
        )}
      </button>
      {/* The mouse's way to what P and Supr do from the keys. */}
      <span
        aria-hidden
        className="absolute top-1 left-1 hidden gap-1 group-focus-within:flex group-hover:flex"
      >
        <button
          type="button"
          tabIndex={-1}
          className={MINI}
          title="Ampliar (P)"
          onClick={onPreview}
        >
          <Icon name="search" size={11} />
        </button>
        {item.source === "pasted" && (
          <button
            type="button"
            tabIndex={-1}
            className={`${MINI} hover:bg-bad`}
            title="Borrar del historial (Supr)"
            onClick={onErase}
          >
            <Icon name="trash" size={11} />
          </button>
        )}
      </span>
    </div>
  );
}

// One image large, in place of the grid: what it is, and the grid's actions for it alone.
// ← → go through the images shown, Espacio marks, Enter pastes, Supr deletes, Esc or P go back.
export function ImagePreview({
  item,
  n,
  armed,
  position: [at, count],
  onStep,
  onToggle,
  onErase,
  onPaste,
  onBack,
  onDrag,
}: {
  item: ImageItem;
  n: number;
  armed: boolean;
  position: [number, number];
  onStep: (step: number) => void;
  onToggle: () => void;
  onErase: () => void;
  onPaste: () => void;
  onBack: () => void;
  onDrag: (e: DragEvent<HTMLElement>) => void;
}) {
  const self = useRef<HTMLFieldSetElement>(null);
  const [size, setSize] = useState<string | null>(null);
  useEffect(() => self.current?.focus(), []);
  const when = relativeTime(new Date(item.mtime).toISOString());
  const onKeyDown = (e: KeyboardEvent<HTMLFieldSetElement>) => {
    if (!plain(e) || e.target !== self.current) return;
    const key = e.key.toLowerCase();
    const act =
      key === "arrowleft"
        ? () => onStep(-1)
        : key === "arrowright"
          ? () => onStep(1)
          : key === " "
            ? onToggle
            : key === "enter"
              ? onPaste
              : key === "p"
                ? onBack
                : isDelete(e)
                  ? onErase
                  : null;
    if (!act) return;
    e.preventDefault();
    act();
  };
  return (
    <fieldset
      ref={self}
      aria-label={`Vista previa: ${item.name}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0 outline-none"
    >
      <div className="relative grid h-[17rem] place-items-center overflow-hidden rounded bg-black/40">
        <img
          src={imageUrl(item.id)}
          alt={item.name}
          draggable
          onDragStart={onDrag}
          onLoad={(e) =>
            setSize(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)
          }
          className="max-h-full max-w-full cursor-grab object-contain"
        />
        {n > 0 && (
          <span className="absolute top-2 right-2 grid size-6 place-items-center rounded-full bg-term-accent font-semibold text-[12px] text-white">
            {n}
          </span>
        )}
        {armed && (
          <span className="absolute inset-x-0 bottom-0 bg-bad/85 py-1 text-center font-medium text-[11px] text-white">
            Pulsa otra vez Borrar para quitarla del historial
          </span>
        )}
        <button
          type="button"
          className={`${MINI} absolute top-1/2 left-2 size-7 -translate-y-1/2 disabled:opacity-30`}
          aria-label="Anterior"
          disabled={at <= 1}
          onClick={() => onStep(-1)}
        >
          <span className="rotate-180">
            <Icon name="chevron" size={14} />
          </span>
        </button>
        <button
          type="button"
          className={`${MINI} absolute top-1/2 right-2 size-7 -translate-y-1/2 disabled:opacity-30`}
          aria-label="Siguiente"
          disabled={at >= count}
          onClick={() => onStep(1)}
        >
          <Icon name="chevron" size={14} />
        </button>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[11px] text-white/85" title={item.name}>
            {item.name}
          </p>
          <p className="text-[11px] text-white/55">
            {[SOURCE[item.source], when, size, byteSize(item.bytes), `${at} de ${count}`]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <button
          type="button"
          className="rounded px-2 py-1 text-[11px] text-white/80 ring-1 ring-white/15 hover:bg-white/10"
          onClick={onBack}
        >
          Volver
        </button>
        <button
          type="button"
          aria-pressed={n > 0}
          className="rounded px-2 py-1 text-[11px] text-white/80 ring-1 ring-white/15 hover:bg-white/10"
          onClick={onToggle}
        >
          {n > 0 ? "Desmarcar" : "Marcar"}
        </button>
        {item.source === "pasted" && (
          <button
            type="button"
            className={`rounded px-2 py-1 text-[11px] ring-1 ${
              armed ? "bg-bad text-white ring-bad" : "text-white/80 ring-white/15 hover:bg-white/10"
            }`}
            onClick={onErase}
          >
            Borrar
          </button>
        )}
      </div>
    </fieldset>
  );
}
