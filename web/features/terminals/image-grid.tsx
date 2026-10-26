import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type DragEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { ImageItem, SourceState } from "../../../server/features/images/store.ts";
import { MAX_BRING_IMAGES } from "../../../shared/terminals.ts";
import { useAccess } from "../../access.ts";
import { ApiError, api, unwrap } from "../../api.ts";
import { Icon } from "../../icons.tsx";
import { captureShortcut, shortcut } from "../../keys.ts";
import { pollEvery } from "../../poll.ts";
import { errorText, InlineError } from "../../ui.tsx";
import {
  BRING_MIME,
  bringErrorText,
  bringTo,
  canCaptureHere,
  captureHere,
  carriesFiles,
  deleteImage,
  encodeBring,
  grantCapture,
  imagesIn,
  pasteProblem,
  uploadAll,
} from "./bring.ts";
import { markAll, stepFocus, toggleMark } from "./image-marks.ts";
import { ImagePreview, ImageThumb, isDelete, plain } from "./image-thumbs.tsx";
import type { Picker } from "./images.tsx";
import { TERM_ICON } from "./panel.tsx";

// The image history's grid: the thumbnails of every source, marked with a click or the keys,
// shown large, dragged to a terminal or pasted into it, and a pasted one deleted. images.tsx
// opens it in a popover.

type ImageList = {
  items: ImageItem[];
  sources: SourceState[];
  clipboard?: { state: string; detail: string | null };
  hotkey?: { state: string; detail: string | null };
};

// Read every 2 s while open: a screenshot saved to the folder sends no event.
function useImages(open: boolean) {
  return useQuery({
    queryKey: ["images"],
    queryFn: async () => unwrap(await api.api.images.$get()),
    enabled: open,
    refetchInterval: open ? pollEvery(2000) : false,
  });
}

const SHOW = { all: "Todas", pasted: "Pegadas", captured: "Capturas", folder: "Carpeta" } as const;
const SOURCE_NAME: Record<SourceState["source"], string> = {
  pasted: "Imágenes pegadas",
  captured: "Capturas",
  folder: "Carpeta de capturas",
};
type Show = keyof typeof SHOW;
const FOLDER_STATE: Record<Exclude<SourceState["state"], "ok">, string> = {
  missing: "no existe",
  denied: "el sistema no deja leerla; dale permiso al servidor en los ajustes de privacidad",
  error: "no se ha podido leer",
};
// What keeps ⌃⌘4 from working; denied has its own line, with the grant.
const HOTKEY_PROBLEM: Record<string, string> = {
  taken: `macOS no deja usar ${captureShortcut(true)}: otra app tiene esas teclas`,
  not_installed: `${captureShortcut(true)} no funciona: falta AgenticCapture.app («bun run mac:build AgenticCapture»)`,
  not_inherited: `macOS no ha dejado capturar con ${captureShortcut(true)}`,
  failed: `El atajo ${captureShortcut(true)} se ha parado`,
};
const SKELETON = "aspect-[4/3] rounded bg-white/5 motion-safe:animate-pulse";
// A delete asks twice; the first press is forgotten after this long.
const ARMED_MS = 4000;

export function ImageGrid({
  id,
  blocked,
  picker,
  grid,
  notice = null,
  preview = null,
  onPreview = () => {},
  onCapture,
  close,
}: {
  id: string | null;
  blocked: string | null;
  picker: Picker;
  grid: React.RefObject<HTMLFieldSetElement | null>;
  notice?: string | null;
  // The image shown large in place of the grid, owned by the popover so Esc can go back.
  preview?: string | null;
  onPreview?: (image: string | null) => void;
  // A terminal's history: Capturar closes it and types the capture into the terminal.
  onCapture?: () => void;
  close: () => void;
}) {
  const desktop = useAccess().data?.desktop;
  // On the Mac the system tool selects a zone; elsewhere the browser shoots this device.
  const capturable = desktop || canCaptureHere();
  // A capture refused for want of Screen Recording: the grant is offered.
  const [denied, setDenied] = useState(false);
  const images = useImages(true);
  const [marked, setMarked] = useState<string[]>([]);
  // Read after an upload, which may end after other clicks.
  const markedNow = useRef(marked);
  markedNow.current = marked;
  const [message, setMessage] = useState<string | null>(null);
  // Enter pressed while an image was uploading: it pastes once the image is marked.
  const queued = useRef(false);
  // Uploads from this panel (Subir, a drop) on their way.
  const [saving, setSaving] = useState(0);
  const [show, setShow] = useState<Show>("all");
  // The pasted image a first delete press is waiting on.
  const [armed, setArmed] = useState<string | null>(null);
  // Files from the system dragged over the panel.
  const [over, setOver] = useState(false);
  const client = useQueryClient();
  // What the user does next, after a capture that is not in the history yet.
  const [hint, setHint] = useState<string | null>(null);
  const shoot = useMutation({
    mutationFn: () => captureHere(desktop),
    onSuccess: (shot) => {
      if ("item" in shot) {
        void client.invalidateQueries({ queryKey: ["images"] });
        setMarked((marks) => markAll(marks, [shot.item.id]));
      } else if ("clipboard" in shot) setHint("Recorta la zona y pulsa Ctrl+V en la terminal.");
    },
    onError: (err) => {
      setDenied(err instanceof ApiError && err.code === "capture_denied");
      setMessage(`No se ha capturado: ${bringErrorText(err)}.`);
    },
  });
  const grant = useMutation({
    mutationFn: grantCapture,
    onSuccess: ({ granted }) => {
      setDenied(false);
      setMessage(null);
      void client.invalidateQueries({ queryKey: ["images"] });
      setHint(
        granted
          ? "Permiso concedido: ya puedes capturar."
          : "Activa AgenticCapture en Ajustes del Sistema › Privacidad y seguridad › Grabación de pantalla y vuelve a pulsar Conceder permiso.",
      );
    },
    onError: (err) => setMessage(`No se ha pedido el permiso: ${bringErrorText(err)}.`),
  });
  const send = useMutation({
    mutationFn: (ids: string[]) => bringTo(id ?? "", { images: ids }),
    onSuccess: close,
    onError: (err) => setMessage(`No se han pegado: ${bringErrorText(err)}.`),
  });
  const remove = useMutation({
    // One already gone is as good as deleted.
    mutationFn: (image: string) =>
      deleteImage(image).catch((err) => {
        if (!(err instanceof ApiError && err.code === "image_gone")) throw err;
      }),
    onSuccess: (_, image) => {
      // The keys go on from the next image, in the preview or in the grid.
      const at = shown.findIndex((i) => i.id === image);
      const next = shown[at + 1] ?? shown[at - 1];
      if (preview === image) onPreview(next?.id ?? null);
      else if (
        grid.current?.contains(document.activeElement) ||
        document.activeElement === document.body
      )
        requestAnimationFrame(() => {
          const thumb =
            next &&
            grid.current?.querySelector<HTMLElement>(`[data-thumb="${CSS.escape(next.id)}"]`);
          (thumb ?? grid.current)?.focus();
        });
      client.setQueryData<ImageList>(
        ["images"],
        (list) => list && { ...list, items: list.items.filter((i) => i.id !== image) },
      );
      void client.invalidateQueries({ queryKey: ["images"] });
      setMarked((marks) => marks.filter((m) => m !== image));
    },
    onError: (err) => setMessage(`No se ha borrado: ${bringErrorText(err)}.`),
  });
  const paste = (ids: string[]) => {
    if (ids.length === 0 || blocked || send.isPending) return;
    if (!id) {
      setMessage("Arrastra las imágenes a una terminal para pegarlas.");
      return;
    }
    setMessage(null);
    send.mutate(ids);
  };
  const marksIn = (kept: string[]) => {
    const next = markAll(markedNow.current, kept);
    setMarked(next);
    if (queued.current) {
      queued.current = false;
      paste(next);
    }
  };

  // The images Cmd+V just kept, or a paste on the terminal sent here, come first and marked.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only new marks change the marks
  useEffect(() => {
    if (picker.marks?.length) marksIn(picker.marks);
  }, [picker.marks]);
  useEffect(() => {
    if (!picker.uploading && !picker.marks && saving === 0) queued.current = false;
  }, [picker.uploading, picker.marks, saving]);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(null), ARMED_MS);
    return () => clearTimeout(t);
  }, [armed]);

  // Images from this device, chosen or dropped: kept, then marked first.
  const keep = async (files: File[], others = 0) => {
    setMessage(
      others ? "Solo se guardan imágenes PNG, JPEG, GIF o WebP; el resto se ha dejado." : null,
    );
    if (files.length === 0) return;
    setSaving((n) => n + 1);
    try {
      const { kept, failed } = await uploadAll(files);
      void client.invalidateQueries({ queryKey: ["images"] });
      marksIn(kept);
      const problem = pasteProblem({ kept, typed: kept.length, failed, refused: null });
      if (problem) setMessage(problem);
    } finally {
      setSaving((n) => n - 1);
    }
  };
  const toggle = (image: string) => {
    setArmed(null);
    const next = toggleMark(marked, image);
    setMessage(next ? null : `Como mucho ${MAX_BRING_IMAGES} imágenes a la vez.`);
    if (next) setMarked(next);
  };
  // A pasted or captured image goes on the second press; a folder's image is the user's and
  // stays.
  const erase = (item: ImageItem) => {
    if (item.source === "folder") {
      setMessage("Solo se borran las imágenes pegadas o capturadas; las de la carpeta son tuyas.");
      return;
    }
    if (armed !== item.id) return setArmed(item.id);
    setArmed(null);
    setMessage(null);
    remove.mutate(item.id);
  };
  // A marked thumbnail carries every marked image; any other, itself.
  const drag = (e: DragEvent<HTMLElement>, image: string) => {
    e.stopPropagation();
    e.dataTransfer.clearData();
    const ids = marked.includes(image) ? marked : [image];
    e.dataTransfer.setData(BRING_MIME, encodeBring({ images: ids }));
    e.dataTransfer.effectAllowed = "copy";
  };

  const items = images.data?.items ?? [];
  const shown = show === "all" ? items : items.filter((i) => i.source === show);
  const sources = images.data?.sources ?? [];
  const failing = sources.filter((s) => s.state !== "ok");
  const clipboard = images.data?.clipboard;
  // The ⌃⌘4 helper runs on the Mac: only there is its state the user's to act on.
  const hotkey = desktop ? images.data?.hotkey?.state : undefined;
  const hotkeyDetail = images.data?.hotkey?.detail ?? null;
  const uploading = picker.uploading || saving > 0;
  const previewed = preview ? shown.find((i) => i.id === preview) : undefined;
  // Back from the preview, the keys go on from the image it showed.
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (preview) {
      last.current = preview;
      return;
    }
    const back = last.current;
    last.current = null;
    if (back)
      (
        grid.current?.querySelector<HTMLElement>(`[data-thumb="${CSS.escape(back)}"]`) ??
        grid.current
      )?.focus();
  }, [preview, grid]);
  // A deleted or filtered-out image leaves the preview.
  useEffect(() => {
    if (preview && images.data && !previewed) onPreview(null);
  }, [preview, previewed, images.data, onPreview]);

  const onKeyDown = (e: KeyboardEvent<HTMLFieldSetElement>) => {
    const thumbs = [...(grid.current?.querySelectorAll<HTMLElement>("[data-thumb]") ?? [])];
    const at = thumbs.indexOf(document.activeElement as HTMLElement);
    const focused = at >= 0 ? shown[at] : undefined;
    if (e.key === "Enter") {
      e.preventDefault();
      if (uploading) queued.current = true;
      else paste(marked.length ? marked : focused ? [focused.id] : []);
      return;
    }
    if (focused && plain(e) && e.key.toLowerCase() === "p") {
      e.preventDefault();
      onPreview(focused.id);
      return;
    }
    if (focused && plain(e) && isDelete(e)) {
      e.preventDefault();
      erase(focused);
      return;
    }
    const next = stepFocus(at, e.key, thumbs.length);
    if (next === null) return;
    e.preventDefault();
    thumbs[next]?.focus();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target only; "Subir…" does the same from the keyboard
    <div
      className={`flex min-w-0 flex-col gap-2 rounded ${over ? "ring-2 ring-term-accent" : ""}`}
      onDragOver={(e) => {
        if (!carriesFiles(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        if (!carriesFiles(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        const { images: files, others } = imagesIn(e.dataTransfer);
        void keep(files, others);
      }}
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0 font-semibold">Imágenes recientes</span>
        {sources.length > 1 && (
          <fieldset className="m-0 flex min-w-0 gap-0.5 border-0 p-0" aria-label="Origen">
            {(Object.keys(SHOW) as Show[]).map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={show === key}
                className={`rounded px-1.5 py-0.5 text-[11px] ${
                  show === key ? "bg-white/15 text-white" : "text-white/60 hover:bg-white/10"
                }`}
                onClick={() => {
                  setShow(key);
                  onPreview(null);
                }}
              >
                {SHOW[key]}
              </button>
            ))}
          </fieldset>
        )}
        <span className="flex-1" />
        <button type="button" className={TERM_ICON} aria-label="Cerrar" onClick={close}>
          <Icon name="close" size={12} />
        </button>
      </div>
      {failing.map((s) => (
        <p key={s.source} role="status" className="text-[11px] text-warn" title={s.detail ?? ""}>
          {SOURCE_NAME[s.source]} <span className="font-mono">{s.dir}</span>:{" "}
          {FOLDER_STATE[s.state as Exclude<SourceState["state"], "ok">]}.
        </p>
      ))}
      {clipboard?.state === "failed" && (
        <p role="status" className="text-[11px] text-warn" title={clipboard.detail ?? ""}>
          El vigilante del portapapeles se ha parado: {clipboard.detail}.
        </p>
      )}
      {(denied || hotkey === "denied") && (
        <p role="status" className="flex items-center gap-2 text-[11px] text-warn">
          <span className="min-w-0 flex-1">
            Para capturar, AgenticCapture necesita el permiso de Grabación de pantalla.
          </span>
          <button
            type="button"
            className="shrink-0 rounded px-2 py-0.5 font-medium text-white/85 ring-1 ring-white/20 hover:bg-white/10 disabled:opacity-40"
            disabled={grant.isPending}
            onClick={() => {
              setHint(null);
              grant.mutate();
            }}
          >
            {grant.isPending ? "Pidiendo…" : "Conceder permiso"}
          </button>
        </p>
      )}
      {hotkey && HOTKEY_PROBLEM[hotkey] && (
        <p role="status" className="text-[11px] text-warn" title={hotkeyDetail ?? ""}>
          {HOTKEY_PROBLEM[hotkey]}
          {(hotkey === "failed" || hotkey === "not_inherited") && hotkeyDetail
            ? `: ${hotkeyDetail}`
            : ""}
          .
        </p>
      )}
      {images.isError && (
        <InlineError className="text-[11px]">
          No se ha podido leer el historial: {errorText(images.error)}.{" "}
          <button type="button" className="underline" onClick={() => void images.refetch()}>
            Reintentar
          </button>
        </InlineError>
      )}
      {previewed ? (
        <ImagePreview
          key={previewed.id}
          item={previewed}
          n={marked.indexOf(previewed.id) + 1}
          armed={armed === previewed.id}
          position={[shown.indexOf(previewed) + 1, shown.length]}
          onStep={(step) => {
            const next = shown[shown.indexOf(previewed) + step];
            if (next) onPreview(next.id);
          }}
          onToggle={() => toggle(previewed.id)}
          onErase={() => erase(previewed)}
          onPaste={() => paste(marked.length ? marked : [previewed.id])}
          onBack={() => onPreview(null)}
          onDrag={(e) => drag(e, previewed.id)}
        />
      ) : (
        <fieldset
          ref={grid}
          aria-label={
            id
              ? "Miniaturas: Espacio marca, Enter pega, P amplía, Supr borra"
              : "Miniaturas: Espacio marca, P amplía, Supr borra"
          }
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className="m-0 grid max-h-[22rem] min-w-0 auto-rows-max grid-cols-4 gap-1.5 overflow-y-auto border-0 p-0 outline-none"
        >
          {uploading && (
            <div
              role="status"
              className="grid aspect-[4/3] place-items-center rounded border border-white/15 text-[11px] text-white/60"
            >
              Guardando…
            </div>
          )}
          {images.isPending
            ? Array.from({ length: 8 }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
                <div key={i} className={SKELETON} />
              ))
            : shown.map((item) => (
                <ImageThumb
                  key={item.id}
                  item={item}
                  n={marked.indexOf(item.id) + 1}
                  armed={armed === item.id}
                  onToggle={() => toggle(item.id)}
                  onPreview={() => onPreview(item.id)}
                  onErase={() => erase(item)}
                  onDrag={(e) => drag(e, item.id)}
                />
              ))}
        </fieldset>
      )}
      {!images.isPending && shown.length === 0 && !uploading && (
        <p className="text-white/60">
          {items.length === 0
            ? `Aún no hay imágenes. Pega una con ${shortcut("V")}, captura una zona con ${captureShortcut()} o suéltala aquí.`
            : "No hay imágenes de este origen."}
        </p>
      )}
      {hint && (
        <p role="status" className="text-[11px] text-white/70">
          {hint}
        </p>
      )}
      {(message || notice || blocked) && (
        <InlineError className="text-[11px]">
          {message ?? notice ?? `Esta terminal no recibe imágenes: ${blocked}.`}
        </InlineError>
      )}
      <div className="flex items-center gap-2 border-white/10 border-t pt-2 text-[11px] text-white/55">
        <span className="min-w-0 flex-1">
          Arrastra una miniatura a cualquier terminal.
          {clipboard?.state === "watching" && " Se guarda cada imagen que copies."}
        </span>
        <label
          className="cursor-pointer rounded px-2 py-1 font-medium text-white/80 ring-1 ring-white/15 hover:bg-white/10"
          title="Sube imágenes de este dispositivo; quedan marcadas en el historial"
        >
          Subir…
          <input
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp,image/gif"
            aria-label="Subir imagen"
            className="sr-only"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = "";
              void keep(files);
            }}
          />
        </label>
        <button
          type="button"
          className="rounded px-2 py-1 font-medium text-white/80 ring-1 ring-white/15 hover:bg-white/10 disabled:opacity-40"
          title={`${
            desktop
              ? "Selecciona una zona de la pantalla"
              : "Elige la pantalla o la ventana de este equipo"
          } (${captureShortcut()}${
            hotkey === "ready" || hotkey === "capturing" ? " en cualquier app" : " en una terminal"
          }); ${onCapture ? "se pega en esta terminal" : "queda marcada en el historial"}`}
          disabled={!capturable || shoot.isPending}
          onClick={() => {
            setMessage(null);
            setHint(null);
            if (!onCapture) return shoot.mutate();
            close();
            onCapture();
          }}
        >
          {!capturable ? "Sin captura aquí" : shoot.isPending ? "Capturando…" : "Capturar"}
        </button>
        {id && (
          <button
            type="button"
            className="rounded bg-term-accent px-2 py-1 font-medium text-white disabled:opacity-40"
            disabled={(marked.length === 0 && !previewed) || Boolean(blocked) || send.isPending}
            onClick={() => paste(marked.length ? marked : previewed ? [previewed.id] : [])}
          >
            {send.isPending
              ? "Pegando…"
              : marked.length === 0 && previewed
                ? "Pegar esta"
                : `Pegar (${marked.length})`}
          </button>
        )}
      </div>
      <p className="text-[10.5px] text-white/40 pointer-coarse:hidden">
        {id ? "Clic o Espacio marca · Enter pega · " : "Clic o Espacio marca · "}P o doble clic
        amplía · Supr borra una pegada o capturada · suelta aquí imágenes del ordenador
      </p>
    </div>
  );
}
