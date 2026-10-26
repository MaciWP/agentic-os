import { z } from "zod";
import type { PasteImageType as Mime } from "../../../shared/terminals.ts";
import { ImageBody, sniff } from "../images/store.ts";
import type { Client } from "./contract.ts";

// The images in a Claude draft, as the hud mod inside that terminal reports them, so the
// terminal's window can show them at full resolution: Claude Code itself draws pixels only
// through kitty's Unicode placeholders, which xterm.js lacks. The mod sends the bytes, never a
// path, so the server reads no file a process names. Kept in memory: a draft is short-lived.
export const MAX_DRAFT_IMAGES = 8;
export const DraftBody = z.strictObject({
  images: z
    .array(z.strictObject({ n: z.number().int().min(1).max(9999), image: ImageBody.shape.image }))
    .max(MAX_DRAFT_IMAGES),
});
type Draft = { n: number; mime: Mime; bytes: Uint8Array<ArrayBuffer>; v: number };

export class Drafts {
  private images = new Map<string, Draft[]>();
  private windows = new Map<string, Set<Client>>();
  private version = 0;

  // Replaces a terminal's draft images and tells its windows; throws when the bytes are not
  // the format they claim. An empty list clears it.
  set(id: string, body: z.infer<typeof DraftBody>): void {
    const next = body.images.map(({ n, image }): Draft => {
      const bytes = new Uint8Array(Buffer.from(image.data, "base64"));
      if (sniff(bytes) !== image.mime) throw Error(`image #${n} is not ${image.mime}`);
      return { n, mime: image.mime, bytes, v: ++this.version };
    });
    if (next.length) this.images.set(id, next);
    else this.images.delete(id);
    this.tell(id);
  }

  // The terminal went away: its draft goes with it.
  clear(id: string): void {
    if (this.images.delete(id)) this.tell(id);
  }

  get(id: string, n: number): Draft | undefined {
    return this.images.get(id)?.find((d) => d.n === n);
  }

  // A window attached to the terminal: it hears the current list at once and every change.
  join(id: string, client: Client): void {
    const set = this.windows.get(id) ?? new Set();
    set.add(client);
    this.windows.set(id, set);
    client.send(this.message(id));
  }

  leave(id: string, client: Client): void {
    const set = this.windows.get(id);
    set?.delete(client);
    if (set && !set.size) this.windows.delete(id);
  }

  private message(id: string): string {
    const images = (this.images.get(id) ?? []).map(({ n, v, bytes }) => ({
      n,
      v,
      size: bytes.length,
    }));
    return JSON.stringify({ type: "drafts", images });
  }

  private tell(id: string): void {
    const message = this.message(id);
    for (const client of this.windows.get(id) ?? []) if (client.isOpen()) client.send(message);
  }
}
