import { useState } from "react";
import { byteSize } from "../../format.ts";
import { machineUrl } from "../../machine.ts";
import { createStore, useStore } from "../../store.ts";
import { Modal } from "../../ui.tsx";
import { HarnessChip } from "./harness.tsx";
import { type TerminalInfo, terminalLabel, useTerminals } from "./queries.ts";
import type { DraftImage } from "./terminal-socket.ts";

// The images in the Claude drafts of this page's terminals at full resolution: Claude Code can
// only draw them as coloured blocks in xterm.js. Each terminal's window publishes what its
// socket says; the shelf at the foot of the Mesa's left rail (or of a popped-out window) shows
// them, so nothing covers a terminal. They go once the prompt is sent.
const drafts = createStore<readonly (readonly [string, DraftImage[]])[]>([]);

export function publishDrafts(id: string, images: DraftImage[]) {
  drafts.update((all) => {
    const rest = all.filter(([other]) => other !== id);
    if (!images.length) return rest.length === all.length ? all : rest;
    // A terminal keeps its place on the shelf as its draft changes.
    return rest.length === all.length
      ? [...all, [id, images] as const]
      : all.map((entry) => (entry[0] === id ? ([id, images] as const) : entry));
  });
}

const src = (id: string, d: DraftImage) =>
  machineUrl(`/api/terminals/${encodeURIComponent(id)}/drafts/${d.n}?v=${d.v}`);

type Open = { id: string; d: DraftImage };

// `vertical`: the folded rail's strip, a thumbnail a row with its number as the badge.
// `floating`: a popped-out window has no rail, so the strip floats over its bottom left corner.
export function DraftShelf({
  vertical = false,
  floating = false,
}: {
  vertical?: boolean;
  floating?: boolean;
}) {
  const narrow = vertical || floating;
  const all = useStore(drafts);
  const terminals = useTerminals().data?.terminals;
  const [sizes, setSizes] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<Open | null>(null);
  if (!all.length) return null;
  const info = (id: string) => terminals?.find((t) => t.id === id);
  // A sent or edited draft drops what was open.
  const large =
    open &&
    all.some(([id, l]) => id === open.id && l.some((d) => d.n === open.d.n && d.v === open.d.v))
      ? open
      : null;
  const facts = (id: string, d: DraftImage) =>
    [sizes[`${id}:${d.n}:${d.v}`], byteSize(d.size)].filter(Boolean).join(" · ");
  const thumb = (id: string, d: DraftImage, t?: TerminalInfo) => (
    <button
      key={`${id}:${d.n}`}
      type="button"
      aria-label={`Ver la imagen ${d.n} en grande`}
      title={`Imagen #${d.n} · ${facts(id, d)}${t ? ` · ${terminalLabel(t)}` : ""}`}
      onClick={() => setOpen({ id, d })}
      className="group flex min-w-0 cursor-zoom-in flex-col gap-1 rounded text-left focus-visible:outline-2 focus-visible:outline-primary"
    >
      <span className="relative block">
        <img
          src={src(id, d)}
          alt={`Imagen ${d.n} del borrador`}
          draggable={false}
          onLoad={(e) => {
            const key = `${id}:${d.n}:${d.v}`;
            const size = `${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`;
            setSizes((s) => (s[key] === size ? s : { ...s, [key]: size }));
          }}
          className={`block rounded border border-line bg-bg object-contain group-hover:border-ink-2 ${narrow ? "h-7 w-7" : "h-[72px] w-full"}`}
        />
        <b
          className={`tile-num absolute shadow-[var(--shadow-1)] ${narrow ? "-right-1 -bottom-1 scale-90" : "top-1 left-1"}`}
        >
          #{d.n}
        </b>
      </span>
      {!narrow && (
        <span className="truncate text-[11px] text-ink-2 tabular-nums">{facts(id, d)}</span>
      )}
    </button>
  );
  return (
    <>
      <section
        aria-label="Imágenes del borrador"
        className={
          floating
            ? "fixed bottom-3 left-3 z-10 flex flex-col items-center gap-2 rounded-lg border border-line bg-panel p-1.5 shadow-[var(--shadow-2)]"
            : vertical
              ? "mt-auto flex flex-col items-center gap-2.5 self-stretch border-line border-t pt-2 pb-1"
              : "max-h-[45%] shrink-0 overflow-y-auto border-line border-t px-2 py-2"
        }
      >
        {!narrow && (
          <h2 className="mb-1.5 font-semibold text-[11px] text-ink-2 uppercase tracking-wide">
            Imágenes del borrador
          </h2>
        )}
        {all.map(([id, images]) => {
          const t = info(id);
          return narrow ? (
            images.map((d) => thumb(id, d, t))
          ) : (
            <div key={id} className="mb-2 last:mb-0">
              {all.length > 1 && t && (
                <div className="mb-1 flex min-w-0">
                  <HarnessChip t={t} />
                </div>
              )}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2">
                {images.map((d) => thumb(id, d, t))}
              </div>
            </div>
          );
        })}
      </section>
      {large && (
        <Modal title={`Imagen #${large.d.n} del borrador`} onClose={() => setOpen(null)}>
          <div className="grid place-items-center bg-bg p-2">
            <img
              src={src(large.id, large.d)}
              alt={`Imagen ${large.d.n} del borrador`}
              className="max-h-[70vh] max-w-full object-contain"
            />
            <p className="mt-2 text-[12px] text-ink-2 tabular-nums">{facts(large.id, large.d)}</p>
          </div>
        </Modal>
      )}
    </>
  );
}
