import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MAX_BRING_IMAGES } from "../../../shared/terminals.ts";
import { useAccess } from "../../access.ts";
import { Icon } from "../../icons.tsx";
import { shortcut } from "../../keys.ts";
import { errorText } from "../../ui.tsx";
import {
  bringErrorText,
  captureHere,
  imagesIn,
  type Pasted,
  pasteInto,
  pasteProblem,
  typeKept,
  uploadAll,
} from "./bring.ts";
import { ImageGrid } from "./image-grid.tsx";
import { TERM_ICON } from "./panel.tsx";

// The image history: the images pasted into the app, its captures and the screenshots folder.
// It never blocks the page: it closes only with Esc inside it or its own button, so the user can
// go on typing, and drag a thumbnail to any terminal. A terminal has its own, which also pastes
// into it; the app header has one for the rest of the app, which only drags.

// Owned by whoever shows it: it opens with `marks` marked first (images just kept), and says
// it is saving while an upload for it runs.
export type Picker = { open: boolean; marks: string[] | null; uploading: boolean };
export const CLOSED: Picker = { open: false, marks: null, uploading: false };

// Keeps images pasted outside a terminal: the history opens at once and marks them once they
// are saved. Why any was not kept reaches the caller, after the history stops waiting.
export async function keepPasted(
  images: File[],
  client: QueryClient,
  set: (next: (picker: Picker) => Picker) => void,
) {
  set(() => ({ open: true, marks: null, uploading: true }));
  const { kept, failed } = await uploadAll(images);
  void client.invalidateQueries({ queryKey: ["images"] });
  set((p) => (p.open ? { ...p, marks: kept, uploading: false } : p));
  return pasteProblem({ kept, typed: kept.length, failed, refused: null });
}

// What a paste, a drop or a capture on a terminal shows over its screen: what to do while the
// selection is open, the images on their way, then, for a moment, how many were typed and a
// way to the history with them marked.
export type Pasting =
  | { capturing: string }
  | { busy: number }
  | { done: number; marks: string[] }
  | null;
const DONE_MS = 4000;
const NOT_IMAGES = "Solo se pegan imágenes PNG, JPEG, GIF o WebP";

const SELECT = "Arrastra una zona · Espacio: ventana · Esc: cancelar";
const PICK = "Elige la pantalla o la ventana que quieres capturar";

// Cmd+V or a drop of images on a terminal: kept in the history and typed at once, as Claude
// Code's own paste does. A capture goes the same way once the selection is made. One at a
// time and in order: a second Cmd+V waits for the first instead of being lost. What went wrong
// goes to `report`, the view's notice, with the files of a drop that were no image (`others`).
export function useImagePaste(id: string, report: (problem: string | null) => void) {
  const client = useQueryClient();
  const desktop = useAccess().data?.desktop;
  const [pasting, setPasting] = useState<Pasting>(null);
  const queue = useRef(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const typed = useCallback(
    (result: Pasted, skipped: string | null = null) => {
      void client.invalidateQueries({ queryKey: ["images"] });
      report([skipped, pasteProblem(result)].filter(Boolean).join(" ") || null);
      if (result.typed === 0) return setPasting(null);
      setPasting({ done: result.typed, marks: result.kept.slice(0, MAX_BRING_IMAGES) });
      timer.current = setTimeout(() => setPasting(null), DONE_MS);
    },
    [client, report],
  );
  const paste = useCallback(
    (files: File[], others = 0) => {
      const skipped = others
        ? `${NOT_IMAGES}${files.length ? "; el resto se ha pegado" : ""}.`
        : null;
      if (files.length === 0) return report(skipped);
      queue.current = queue.current.then(async () => {
        clearTimeout(timer.current);
        report(skipped);
        setPasting({ busy: files.length });
        try {
          typed(await pasteInto(id, files), skipped);
        } catch (err) {
          setPasting(null);
          report(`No se ha pegado la imagen: ${errorText(err)}.`);
        }
      });
    },
    [id, report, typed],
  );
  // Capturar or its keys: a selection on screen, kept as a capture and typed here. A cancel
  // leaves nothing.
  const capture = useCallback(() => {
    queue.current = queue.current.then(async () => {
      clearTimeout(timer.current);
      report(null);
      setPasting({ capturing: desktop ? SELECT : PICK });
      try {
        const shot = await captureHere(desktop);
        if (!("item" in shot)) {
          setPasting(null);
          if ("clipboard" in shot) report("Recorta la zona y pulsa Ctrl+V en la terminal.");
          return;
        }
        setPasting({ busy: 1 });
        typed(await typeKept(id, [shot.item.id]));
      } catch (err) {
        setPasting(null);
        report(`No se ha capturado: ${bringErrorText(err)}.`);
      }
    });
  }, [id, desktop, report, typed]);
  return { pasting, paste, capture };
}

// Over the terminal's screen, not above it: the terminal keeps its size while it shows.
export function PasteStatus({
  pasting,
  onHistory,
}: {
  pasting: Pasting;
  onHistory: (marks: string[]) => void;
}) {
  if (!pasting) return null;
  return (
    <div
      role="status"
      className="pointer-events-none absolute top-2 right-3 z-10 flex max-w-[calc(100%-1.5rem)] justify-end"
    >
      <div className="pointer-events-auto flex min-w-0 items-center gap-2 rounded-full border border-white/10 bg-term-header/95 px-3 py-1 text-[12px] text-term-ink shadow-[var(--shadow-2)]">
        {"capturing" in pasting ? (
          <span className="truncate">{pasting.capturing}</span>
        ) : "busy" in pasting ? (
          <span className="truncate">
            {pasting.busy === 1 ? "Pegando la imagen…" : `Pegando ${pasting.busy} imágenes…`}
          </span>
        ) : (
          <>
            <Icon name="check" size={12} />
            <span className="truncate">
              {pasting.done === 1 ? "Imagen pegada" : `${pasting.done} imágenes pegadas`}
            </span>
            <button
              type="button"
              className="shrink-0 text-white/70 underline hover:text-white"
              onClick={() => onHistory(pasting.marks)}
            >
              Ver en el historial
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function ImagePicker({
  id,
  blocked,
  picker,
  onChange,
  onClosed,
  onCapture,
  trigger = TERM_ICON,
  notice = null,
  children,
}: {
  // The terminal Pegar and Enter paste into; null for the app's, which only drags.
  id: string | null;
  blocked: string | null;
  picker: Picker;
  onChange: (picker: Picker) => void;
  // The terminal takes the focus back; without it, the button does.
  onClosed?: () => void;
  // A terminal's Capturar: the history closes and the capture is typed into the terminal.
  onCapture?: () => void;
  trigger?: string;
  // Why the last Cmd+V image was not kept, from the owner.
  notice?: string | null;
  // Shown beside the button; the panel hangs from both, so it has a place when the button is
  // hidden.
  children?: ReactNode;
}) {
  const content = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLFieldSetElement>(null);
  // The image shown large, in place of the grid; Esc goes back to the grid first.
  const [preview, setPreview] = useState<string | null>(null);
  const button = (
    <PopoverTrigger asChild>
      <button
        type="button"
        className={trigger}
        aria-label="Imágenes recientes"
        title={
          id
            ? `Imágenes recientes (${shortcut("V", { shift: true })}): marca las que quieras o arrástralas a una terminal`
            : `Imágenes recientes (${shortcut("V", { shift: true })}): arrástralas a una terminal`
        }
      >
        <Icon name="images" size={14} />
      </button>
    </PopoverTrigger>
  );
  return (
    <Popover
      modal={false}
      open={picker.open}
      onOpenChange={(open) => {
        setPreview(null);
        onChange(open ? { ...CLOSED, open } : CLOSED);
      }}
    >
      {children ? (
        <PopoverAnchor asChild>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {button}
            {children}
          </div>
        </PopoverAnchor>
      ) : (
        button
      )}
      <PopoverContent
        ref={content}
        align="end"
        aria-label="Imágenes recientes"
        data-picker={id ? "terminal" : "app"}
        className="w-[min(34rem,calc(100vw-1rem))] gap-2 bg-term-header p-2 text-[12px] text-term-ink ring-white/15"
        // Focus goes to the grid, never to the terminal: Enter there pastes, not submits.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          grid.current?.focus();
        }}
        onInteractOutside={(e) => e.preventDefault()}
        onFocusOutside={(e) => e.preventDefault()}
        // Esc in the terminal belongs to the program running there; in the preview it goes back
        // to the grid.
        onEscapeKeyDown={(e) => {
          if (!content.current?.contains(document.activeElement)) e.preventDefault();
          else if (preview) {
            e.preventDefault();
            setPreview(null);
          }
        }}
        onCloseAutoFocus={(e) => {
          if (!onClosed) return;
          e.preventDefault();
          onClosed();
        }}
      >
        <ImageGrid
          id={id}
          blocked={blocked}
          picker={picker}
          grid={grid}
          notice={notice}
          preview={preview}
          onPreview={setPreview}
          onCapture={onCapture}
          close={() => {
            setPreview(null);
            onChange(CLOSED);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

// Where Cmd+V and Cmd+Shift+V keep their usual meaning: text fields (the code editor among
// them), and a terminal or its own history, which handle images themselves.
function ownTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  if (target.closest('.xterm, [data-picker="terminal"], .monaco-editor')) return true;
  return target.closest("input, textarea, select, [contenteditable='true']") !== null;
}

// The history for the rest of the app, in its header: Cmd+Shift+V opens it, and Cmd+V with
// images keeps them and marks them there. Thumbnails reach a terminal by dragging. Below 1440 px
// the header has no room for its button (Consumo's bar fills it), so only the keys open it
// there.
export function AppImages({ children }: { children: ReactNode }) {
  const [picker, setPicker] = useState<Picker>(CLOSED);
  const [notice, setNotice] = useState<string | null>(null);
  const client = useQueryClient();
  useFileDropGuard();
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || ownTarget(e.target)) return;
      if (e.key.toLowerCase() !== "v" || !e.shiftKey || !(e.metaKey || e.ctrlKey) || e.altKey)
        return;
      e.preventDefault();
      setPicker((p) => (p.open ? p : { ...CLOSED, open: true }));
    };
    // One paste at a time, in order, as in a terminal.
    let queue = Promise.resolve();
    const onPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented || ownTarget(e.target)) return;
      const { images } = imagesIn(e.clipboardData);
      if (images.length === 0) return;
      e.preventDefault();
      queue = queue
        .then(async () => {
          setNotice(null);
          setNotice(await keepPasted(images, client, setPicker));
        })
        .catch((err) => setNotice(`No se ha guardado la imagen: ${errorText(err)}.`));
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("paste", onPaste);
    };
  }, [client]);
  return (
    <ImagePicker
      id={null}
      blocked={null}
      picker={picker}
      onChange={(next) => {
        if (!next.open) setNotice(null);
        setPicker(next);
      }}
      trigger="btn-ghost hidden size-7 justify-center min-[1440px]:inline-flex"
      notice={notice}
    >
      {children}
    </ImagePicker>
  );
}

// A file dropped where nothing takes it would make the browser open it in place of the app.
// Whatever takes files (a terminal, the history) prevents the default itself, first.
export function useFileDropGuard() {
  useEffect(() => {
    const guard = (e: DragEvent) => {
      if (e.defaultPrevented || !e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      if (e.type === "dragover") e.dataTransfer.dropEffect = "none";
    };
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", guard);
    return () => {
      window.removeEventListener("dragover", guard);
      window.removeEventListener("drop", guard);
    };
  }, []);
}
