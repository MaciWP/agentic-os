import { type DragEvent, useState } from "react";
import { z } from "zod";
import type { ImageItem } from "../../../server/features/images/store.ts";
import { ISSUE_KEY } from "../../../shared/envs.ts";
import {
  IMAGE_ID,
  MAX_BRING_IMAGES,
  MAX_PASTE_IMAGE_BYTES,
  PASTE_IMAGE_TYPES,
  type PasteImageType,
} from "../../../shared/terminals.ts";
import { PROMPT_REFUSAL_TEXT, promptRefusal } from "../../../shared/work-bar.ts";
import { ApiError, mutate } from "../../api.ts";
import { shortcut } from "../../keys.ts";
import { currentMachine, machineUrl } from "../../machine.ts";
import { storageKey } from "../../storage.ts";
import { errorText } from "../../ui.tsx";
import type { TerminalInfo } from "./queries.ts";

// "Llevar a terminal": a ticket, a PR or images of the history typed into a running terminal,
// never followed by Enter. The server builds the text: a shell gets the key or the PR ref with
// its link, an agent the whole ticket or PR with its discussion and, only with a task, what to
// do with it; images become their paths. A work bar prompt (its saved prompt's id) is the one
// sent with Enter, filled with the terminal's context.
export type BringItem =
  | { ticket: string; task?: "work" | "review" }
  | { pr: { repo: string; number: number }; task?: "review" }
  | { images: string[] }
  | { prompt: string };

// What a card brings to an agent: its content alone, or with the task a launch would give.
export type BringMode = "content" | "task";
// Kept in this browser; read again by every rail and palette that mounts.
export const bringMode = storageKey("aos.bring-mode", {
  schema: z.enum(["content", "task"]),
  fallback: "content",
  legacy: "bring-mode",
});

export function useBringMode() {
  const [mode, setMode] = useState(bringMode.get);
  const keep = (next: BringMode) => {
    setMode(next);
    bringMode.set(next);
  };
  return [mode, keep] as const;
}

// The item as the mode asks: the task is Trabajar for my tickets, Revisar for the rest.
export function withMode(item: BringItem, mode: BringMode, mine = true): BringItem {
  if ("images" in item || "prompt" in item) return item;
  if ("ticket" in item)
    return mode === "task"
      ? { ticket: item.ticket, task: mine ? "work" : "review" }
      : { ticket: item.ticket };
  return mode === "task" ? { pr: item.pr, task: "review" } : { pr: item.pr };
}

// Dragged only under this type. A text/plain copy would let the drop land on xterm's own
// textarea and go straight to the PTY, past the server's checks.
export const BRING_MIME = "application/x-aos-bring";
// Set beside BRING_MIME by a work bar button: a drag shows only its types until the drop, and
// a tile needs to know before then whether its agent can take a prompt now.
export const PROMPT_MIME = "application/x-aos-bring-prompt";

export const bringLabel = (item: BringItem) =>
  "prompt" in item
    ? `«${item.prompt.replace(/^prompts:/, "").replace(/\.md$/, "")}»`
    : "ticket" in item
      ? item.ticket
      : "images" in item
        ? item.images.length === 1
          ? "1 imagen"
          : `${item.images.length} imágenes`
        : `${item.pr.repo}#${item.pr.number}`;

export const encodeBring = (item: BringItem) => JSON.stringify(item);

// What a drop carries, or null for anything this app did not put there.
export function decodeBring(raw: string): BringItem | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  // One item key, and a task only beside a ticket or a PR.
  const tasked = "task" in o;
  if (Object.keys(v).length !== (tasked ? 2 : 1)) return null;
  if (typeof o.ticket === "string") {
    if (!ISSUE_KEY.test(o.ticket)) return null;
    if (!tasked) return { ticket: o.ticket };
    return o.task === "work" || o.task === "review" ? { ticket: o.ticket, task: o.task } : null;
  }
  if (typeof o.prompt === "string")
    return tasked || !o.prompt || o.prompt.length > 1024 ? null : { prompt: o.prompt };
  if (Array.isArray(o.images)) {
    if (tasked) return null;
    const ids = o.images;
    const ok =
      ids.length > 0 &&
      ids.length <= MAX_BRING_IMAGES &&
      ids.every((x) => typeof x === "string" && IMAGE_ID.test(x));
    return ok ? { images: ids as string[] } : null;
  }
  const pr = o.pr as Record<string, unknown> | null | undefined;
  if (
    pr &&
    typeof pr === "object" &&
    typeof pr.repo === "string" &&
    pr.repo.length > 0 &&
    Number.isInteger(pr.number) &&
    (pr.number as number) > 0 &&
    (!tasked || o.task === "review")
  ) {
    const ref = { repo: pr.repo, number: pr.number as number };
    return tasked ? { pr: ref, task: "review" } : { pr: ref };
  }
  return null;
}

// Why a terminal cannot take it, or null when it can. The server refuses the same cases. A
// bar prompt also needs an agent waiting for its next message.
export function bringBlocked(t: TerminalInfo | undefined, prompt = false): string | null {
  if (!t) return "la terminal ya no existe";
  if (t.harness === "env") return "un comando de entorno no recibe texto";
  if (t.state !== "running") return "la terminal no está en marcha";
  const refusal = prompt ? promptRefusal(t) : null;
  return refusal && PROMPT_REFUSAL_TEXT[refusal];
}

export const bringTo = (id: string, item: BringItem) =>
  mutate<{ sent: boolean }>(`/api/terminals/${encodeURIComponent(id)}/bring`, "POST", item);

// The images a paste or a drop carries, in order, and how many other files came with them. A
// screenshot tool puts text beside its image; the image wins, and text alone is no image.
export function imagesIn(data: DataTransfer | null): { images: File[]; others: number } {
  const images: File[] = [];
  let others = 0;
  for (const item of data?.items ?? []) {
    if (item.kind !== "file") continue;
    const file = PASTE_IMAGE_TYPES.includes(item.type as PasteImageType) ? item.getAsFile() : null;
    if (file) images.push(file);
    else others += 1;
  }
  return { images, others };
}

// A drag that carries files from the system (Finder, the desktop), not one of the app's own.
export const carriesFiles = (data: DataTransfer) =>
  data.types.includes("Files") && !data.types.includes(BRING_MIME);

const base64 = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

// A pasted image goes into the history; the picker then offers it, marked. A capture this
// browser took goes with the captures.
export async function uploadImage(file: File, source?: "captured") {
  if (file.size > MAX_PASTE_IMAGE_BYTES) throw new Error("la imagen pasa de 10 MB");
  return mutate<{ item: ImageItem }>("/api/images", "POST", {
    ...(source && { source }),
    image: { mime: file.type, data: await base64(file) },
  });
}

// Several images into the history, one after another: the ids kept, in order, and why each
// of the others failed. One bad image does not stop the rest.
export async function uploadAll(files: File[]) {
  const kept: string[] = [];
  const failed: string[] = [];
  for (const file of files) {
    try {
      kept.push((await uploadImage(file)).item.id);
    } catch (err) {
      failed.push(bringErrorText(err));
    }
  }
  return { kept, failed };
}

// Only a pasted or captured image goes; the server refuses a folder's.
export const deleteImage = (id: string) =>
  mutate<{ removed: true }>(`/api/images/${encodeURIComponent(id)}`, "DELETE");

export type Pasted = {
  // Every image kept in the history, in order.
  kept: string[];
  // How many of them were typed: none when the terminal refused, at most the cap.
  typed: number;
  // Why each image that was not kept failed.
  failed: string[];
  // Why the terminal did not take them.
  refused: string | null;
};

// Images pasted or dropped on a terminal: each one kept in the history first, so none is lost
// when the terminal refuses, then the paths of the first MAX_BRING_IMAGES typed on one line,
// never followed by Enter.
export async function pasteInto(id: string, files: File[]): Promise<Pasted> {
  const { kept, failed } = await uploadAll(files);
  return typeKept(id, kept, failed);
}

// Images already in the history typed into a terminal, as pasteInto does after keeping them.
export async function typeKept(id: string, kept: string[], failed: string[] = []): Promise<Pasted> {
  const typed = kept.slice(0, MAX_BRING_IMAGES);
  if (typed.length === 0) return { kept, typed: 0, failed, refused: null };
  try {
    await bringTo(id, { images: typed });
    return { kept, typed: typed.length, failed, refused: null };
  } catch (err) {
    return { kept, typed: 0, failed, refused: bringErrorText(err) };
  }
}

// What went wrong with a paste, in words, or null when every image was typed.
export function pasteProblem({ kept, typed, failed, refused }: Pasted): string | null {
  const parts: string[] = [];
  if (refused)
    parts.push(
      `No se ha pegado ${kept.length === 1 ? "la imagen" : `ninguna de las ${kept.length} imágenes`}: ${refused}. Está${kept.length === 1 ? "" : "n"} en el historial (${shortcut("V", { shift: true })}).`,
    );
  else if (typed < kept.length)
    parts.push(
      `Se han pegado ${typed} de ${kept.length} imágenes: como mucho ${MAX_BRING_IMAGES} a la vez; el resto está en el historial.`,
    );
  if (failed.length === 1) parts.push(`No se ha guardado una imagen: ${failed[0]}.`);
  else if (failed.length > 1)
    parts.push(`No se han guardado ${failed.length} imágenes: ${failed[0]}.`);
  return parts.length ? parts.join(" ") : null;
}

// "Capturar" on the Mac: its own selection, kept as a capture. A Windows server leaves the cut
// on the clipboard.
export const captureImage = () =>
  mutate<{ item: ImageItem } | { cancelled: true } | { clipboard: true }>(
    "/api/images/capture",
    "POST",
    {},
  );

// The browser can show its screen picker here (a desktop browser; Android has none).
export const canCaptureHere = () =>
  typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function";

const frameOf = (video: HTMLVideoElement) =>
  new Promise<void>((resolve) =>
    "requestVideoFrameCallback" in video
      ? video.requestVideoFrameCallback(() => resolve())
      : resolve(),
  );
const encoded = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

// "Capturar" on a remote device: one frame of the screen or window the user picks on that
// device, kept as a capture. The Mac's capture would shoot the Mac's screen.
export async function captureClientScreen(): Promise<{ item: ImageItem } | { cancelled: true }> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotAllowedError") return { cancelled: true };
    throw err;
  }
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    await frameOf(video);
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    // A busy 4K screen can pass the upload limit as PNG; JPEG keeps it readable and small.
    let blob = await encoded(canvas, "image/png");
    if (blob && blob.size > MAX_PASTE_IMAGE_BYTES) blob = await encoded(canvas, "image/jpeg", 0.9);
    if (!blob) throw new Error("el navegador no ha podido codificar la captura");
    return await uploadImage(new File([blob], "captura", { type: blob.type }), "captured");
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}

// The way a capture starts here: the Mac's selection on the Mac itself, the browser's screen
// picker on any other device.
export const captureHere = (desktop: boolean | undefined) =>
  desktop ? captureImage() : captureClientScreen();

// "Conceder permiso": macOS's request for Screen Recording, or System Settings after a no.
export const grantCapture = () => mutate<{ granted: boolean }>("/api/images/capture/grant", "POST");

// Where a ⌃⌘4 capture goes: the hub's terminal focused last, with the name the notice shows.
// A worker's terminal is none, since a path on the Mac means nothing on the PC; so this always
// goes to the hub. Sent on every focus, so a restarted hub learns it again on the next one; a
// failed send changes nothing but where a capture lands.
export function reportTarget(id: string, label: string) {
  const target = currentMachine ? { terminal: null } : { terminal: id, label: label.slice(0, 80) };
  void fetch(machineUrl("/api/images/target", ""), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(target),
  }).catch(() => {});
}

const BRING_ERROR: Record<string, string> = {
  capture_busy: "ya hay una captura abierta",
  capture_failed: "el sistema no ha podido capturar la pantalla",
  capture_denied: "falta el permiso de Grabación de pantalla para AgenticCapture",
  capture_unavailable:
    "falta AgenticCapture.app; constrúyela con «bun run mac:build AgenticCapture»",
  bad_image: "no es una imagen PNG, JPEG, GIF o WebP válida",
  unknown_image: "esa imagen no está en el historial",
  image_gone: "la imagen ya no está en su carpeta",
  not_pasted: "solo se borran las imágenes pegadas o capturadas; las de la carpeta son tuyas",
  too_large: "la imagen pasa de 10 MB",
  no_paste: "la terminal aún no acepta texto pegado (quizá está arrancando)",
  not_an_input: "un comando de entorno no recibe texto",
  not_running: "la terminal no está en marcha",
  not_found: "la terminal ya no existe",
  jira_not_configured: "Jira no está configurado",
  ...PROMPT_REFUSAL_TEXT,
};

export function bringErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    const known = BRING_ERROR[err.code];
    if (err.code === "missing") return `${known} ${err.detail}`;
    if (known) return known;
    if (err.code === "launch_rejected" && err.detail) return err.detail;
  }
  return errorText(err);
}

// A tile of the Mesa as a target: its number on screen, its name, and why it cannot take
// text, if it cannot.
export type Target = { id: string; n: number; name: string; blocked: string | null };

// Only the card pressed travels, and its image is that card. Chrome drags a text selection
// left across cards instead of the card (its image shows every card in it, with a text/plain
// copy), so the card drops any selection when pressed and replaces whatever data was set.
export const startBring = (item: BringItem) => (e: DragEvent<HTMLElement>) => {
  e.dataTransfer.clearData();
  e.dataTransfer.setData(BRING_MIME, encodeBring(item));
  if ("prompt" in item) e.dataTransfer.setData(PROMPT_MIME, "1");
  e.dataTransfer.effectAllowed = "copy";
  const r = e.currentTarget.getBoundingClientRect();
  e.dataTransfer.setDragImage(e.currentTarget, e.clientX - r.left, e.clientY - r.top);
};
