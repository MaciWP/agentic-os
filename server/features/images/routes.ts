import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { MAX_PASTE_IMAGE_BYTES } from "../../../shared/terminals.ts";
import { log } from "../../log.ts";
import { type Captured, capture } from "./capture.ts";
import type { WatchState } from "./clipboard-watch.ts";
import { type CaptureHotkey, HotkeyReport, type HotkeyState, SHOT_NAME } from "./hotkey.ts";
import { ImageBody, ImageError, type ImageStore, readChecked } from "./store.ts";

// A pasted image in base64 is the largest body the API takes.
export const imageBodyLimit = bodyLimit({
  maxSize: Math.ceil(MAX_PASTE_IMAGE_BYTES / 3) * 4 + 1024,
  onError: (c) => c.json({ error: "too_large", detail: "image too large" }, 413),
});

const OFF: WatchState = { state: "off", detail: null };
const HOTKEY_OFF: HotkeyState = { state: "off", detail: null };
const NO_TARGET = "Guardada en el historial: no hay terminal activa";

// The terminal focused last in the app, with the name the app shows for it.
const TargetBody = z.strictObject({
  terminal: z.string().min(1).max(200).nullable(),
  label: z.string().min(1).max(80).optional(),
});
const ShotBody = z.strictObject({ file: z.string().regex(SHOT_NAME) });

export function imageRoutes(
  images: ImageStore,
  {
    shoot = capture,
    clipboard = () => OFF,
    hotkey = null,
    typeInto = async () => false,
  }: {
    shoot?: () => Promise<Captured>;
    clipboard?: () => WatchState;
    hotkey?: CaptureHotkey | null;
    // Types a kept image's path into a terminal; false when it takes no input.
    typeInto?: (terminal: string, path: string) => Promise<boolean>;
  } = {},
) {
  let capturing = false;
  let target: { id: string; label: string } | null = null;

  // A ⌃⌘4 capture's path typed into the terminal focused last; the answer is the notice the
  // helper shows.
  const typeCapture = async (path: string) => {
    const to = target;
    if (!to) return NO_TARGET;
    const sent = await typeInto(to.id, path);
    log("images").info(`capture into ${to.id}${sent ? "" : ", refused"}`);
    return sent ? `Captura pegada en ${to.label}` : NO_TARGET;
  };

  return (
    new Hono()
      .get("/", async (c) =>
        c.json({
          ...(await images.list()),
          clipboard: clipboard(),
          hotkey: hotkey?.state() ?? HOTKEY_OFF,
        }),
      )
      // The bytes of one image, for the picker's thumbnails: only this origin may embed them,
      // and nothing keeps them.
      .get("/:id", async (c) => {
        const image = await images.resolve(c.req.param("id"));
        return c.body(image.bytes, 200, {
          "Content-Type": image.mime,
          "X-Content-Type-Options": "nosniff",
          "Cross-Origin-Resource-Policy": "same-origin",
          "Cache-Control": "no-store",
        });
      })
      // A pasted or captured image out of the history; a folder's image is refused.
      .delete("/:id", async (c) => {
        await images.remove(c.req.param("id"));
        return c.json({ removed: true as const });
      })
      // One selection on screen at a time; the image is kept as a capture.
      .post("/capture", async (c) => {
        if (capturing) throw new ImageError("a capture is already open", "capture_busy");
        capturing = true;
        try {
          const shot = await shoot();
          if (shot.kind === "cancelled") return c.json({ cancelled: true as const });
          if (shot.kind === "clipboard") return c.json({ clipboard: true as const });
          const { item } = await images.save(shot.bytes, undefined, "captured");
          return c.json({ item });
        } finally {
          capturing = false;
        }
      })
      // "Conceder permiso" for Screen Recording, which AgenticCapture needs.
      .post("/capture/grant", async (c) => {
        if (!hotkey) throw new ImageError("no capture on this server", "capture_unavailable");
        return c.json(await hotkey.grant());
      })
      // Where a ⌃⌘4 capture goes: the app says which terminal has the focus, or none.
      .post("/target", async (c) => {
        const body = TargetBody.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
        const { terminal, label } = body.data;
        target = terminal ? { id: terminal, label: label ?? terminal } : null;
        return c.json({ target: terminal });
      })
      // The ⌃⌘4 helper's state, from the helper itself.
      .post("/hotkey/state", async (c) => {
        const body = HotkeyReport.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
        if (!hotkey?.report(body.data)) return c.json({ error: "not_ours" }, 409);
        return c.json({ accepted: true as const });
      })
      // A ⌃⌘4 capture the helper left in its folder: kept, removed from there, typed into the
      // terminal focused last. Kept even when no terminal takes it.
      .post("/hotkey/shot", async (c) => {
        const body = ShotBody.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
        if (!hotkey) return c.json({ error: "not_ours" }, 409);
        const { file } = body.data;
        let bytes: Uint8Array;
        try {
          ({ bytes } = await readChecked(hotkey.dir, file));
        } finally {
          await unlink(join(hotkey.dir, file)).catch(() => {});
        }
        const { item, path } = await images.save(bytes, undefined, "captured");
        hotkey.settled();
        return c.json({ item, text: await typeCapture(path) });
      })
      // A pasted image goes into the history; the picker then offers it first. A capture the
      // browser took itself goes with the captures.
      .post("/", imageBodyLimit, async (c) => {
        const body = ImageBody.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
        const { source, image } = body.data;
        const { item } = await images.save(Buffer.from(image.data, "base64"), image.mime, source);
        return c.json({ item });
      })
  );
}
