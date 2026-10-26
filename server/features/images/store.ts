import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
  MAX_PASTE_IMAGE_BYTES as MAX_IMAGE_BYTES,
  type PasteImageType as Mime,
  PASTE_IMAGE_TYPES,
} from "../../../shared/terminals.ts";
import { errorMessage } from "../../error-message.ts";

// The images a terminal can take: the ones pasted into the app, the ones it captured, and the
// ones in folders the server reads (the screenshots folder). Every image is named by an id, `source:file name`,
// and the server resolves it to a file it checks itself; a request never carries a path.

const EXT: Record<Mime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

// Base64 is 4/3 of the bytes; anything longer cannot decode under the cap.
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
export const ImageBody = z.strictObject({
  // A capture the browser took itself (its screen picker), kept with the server's own.
  source: z.literal("captured").optional(),
  image: z.strictObject({
    mime: z.enum(PASTE_IMAGE_TYPES),
    data: z
      .string()
      .min(4)
      .max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
      .refine((d) => d.length % 4 === 0 && BASE64.test(d), "not base64"),
  }),
});

// The format the bytes themselves say, whatever the clipboard or the file name claimed.
export function sniff(b: Uint8Array): Mime | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, j) => b[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61)
    return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

// Only files this module wrote are ever listed as pasted or pruned; a write in progress has
// the dot name and becomes an image only by its rename.
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const OURS = new RegExp(`^${UUID}\\.(png|jpg|gif|webp)$`);
const PARTIAL = new RegExp(`^\\.${UUID}\\.tmp$`);
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
// A folder lists what looks like an image; its bytes are checked when it is read.
const PICTURE = /^[^.].*\.(png|jpe?g|gif|webp)$/i;

export type ImageErrorCode =
  | "bad_image"
  | "unknown_image"
  | "image_gone"
  | "not_pasted"
  | "capture_busy"
  | "capture_denied"
  | "capture_unavailable"
  | "capture_failed";
export class ImageError extends Error {
  constructor(
    message: string,
    readonly code: ImageErrorCode = "bad_image",
  ) {
    super(message);
  }
}

// Writes the image under a name the server picks (0600, in a 0700 folder): to a dot name
// first, then renamed, so a list never reads half a file. Drops its own files older than a
// week. Returns the absolute path.
export async function saveImage(
  dir: string,
  bytes: Uint8Array,
  { claimed, now = Date.now() }: { claimed?: Mime; now?: number } = {},
) {
  const mime = checkImage(bytes, claimed);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  for (const name of await readdir(dir)) {
    if (!OURS.test(name) && !PARTIAL.test(name)) continue;
    const path = join(dir, name);
    const s = await stat(path).catch(() => null);
    if (s && now - s.mtimeMs > KEEP_MS) await unlink(path).catch(() => {});
  }
  const id = randomUUID();
  const partial = join(dir, `.${id}.tmp`);
  const path = join(dir, `${id}.${EXT[mime]}`);
  await writeFile(partial, bytes, { mode: 0o600, flag: "wx" });
  await rename(partial, path);
  return path;
}

// The type of an image within the cap, and the one it claimed to be, if any.
function checkImage(bytes: Uint8Array, claimed?: Mime): Mime {
  if (bytes.length > MAX_IMAGE_BYTES) throw new ImageError("image too large");
  const mime = sniff(bytes);
  if (!mime) throw new ImageError("not a PNG, JPEG, GIF or WebP image");
  if (claimed && mime !== claimed) throw new ImageError(`the bytes are not ${claimed}`);
  return mime;
}

const errno = (err: unknown) => (err as NodeJS.ErrnoException).code;

// A file of this folder, read only if it is what it claims: a regular file (no symlink)
// inside the folder's real path, within the cap, and bytes that are an image. The caller has
// checked the name.
export async function readChecked(
  dir: string,
  name: string,
): Promise<{ path: string; mime: Mime; bytes: Uint8Array<ArrayBuffer> }> {
  const path = join(dir, name);
  const gone = () => new ImageError(`${name} is no longer there`, "image_gone");
  const link = await lstat(path).catch((err) => {
    throw errno(err) === "ENOENT" ? gone() : err;
  });
  if (!link.isFile()) throw new ImageError(`${name} is not a regular file`, "unknown_image");
  const [realDir, realFile] = await Promise.all([realpath(dir), realpath(path)]);
  if (dirname(realFile) !== realDir)
    throw new ImageError(`${name} is outside its folder`, "unknown_image");
  // O_NOFOLLOW: a symlink swapped in after the checks is refused at open.
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((err) => {
    throw errno(err) === "ENOENT" ? gone() : err;
  });
  try {
    const s = await handle.stat();
    if (!s.isFile()) throw new ImageError(`${name} is not a regular file`, "unknown_image");
    if (s.size > MAX_IMAGE_BYTES) throw new ImageError(`${name} is larger than 10 MB`);
    const bytes = new Uint8Array(await handle.readFile());
    const mime = sniff(bytes);
    if (!mime) throw new ImageError(`${name} is not a PNG, JPEG, GIF or WebP image`);
    return { path, mime, bytes };
  } finally {
    await handle.close();
  }
}

export type SourceId = "pasted" | "captured" | "folder";
// The sources the app writes to itself.
export type OwnSourceId = Exclude<SourceId, "folder">;
export type ImageSource = {
  id: SourceId;
  dir: string;
  // The app's own folder: missing means nothing pasted yet, and only its files are reused
  // in place.
  own: boolean;
};
export type SourceState = {
  source: SourceId;
  state: "ok" | "missing" | "denied" | "error";
  dir: string;
  detail: string | null;
};
export type ImageItem = {
  id: string;
  source: SourceId;
  name: string;
  mtime: number;
  bytes: number;
};
export type Resolved = {
  source: ImageSource;
  path: string;
  mime: Mime;
  bytes: Uint8Array<ArrayBuffer>;
};

export const LIST_LIMIT = 30;

const lists = (s: ImageSource, name: string) => (s.own ? OURS : PICTURE).test(name);

export class ImageStore {
  constructor(
    // Resolved on each call: the screenshots folder is read from the OS and may change.
    private readonly sources: () => Promise<ImageSource[]>,
    private readonly pastesDir: string,
    private readonly now = Date.now,
  ) {}

  // The newest images of every source. A source that cannot be read says why, on its own:
  // the others are still listed.
  async list(limit = LIST_LIMIT): Promise<{ items: ImageItem[]; sources: SourceState[] }> {
    const items: ImageItem[] = [];
    const states: SourceState[] = [];
    for (const source of await this.sources()) {
      const state: SourceState = { source: source.id, state: "ok", dir: source.dir, detail: null };
      try {
        for (const entry of await readdir(source.dir, { withFileTypes: true })) {
          if (!entry.isFile() || !lists(source, entry.name)) continue;
          const s = await lstat(join(source.dir, entry.name)).catch(() => null);
          if (!s?.isFile() || s.size > MAX_IMAGE_BYTES) continue;
          items.push({
            id: `${source.id}:${entry.name}`,
            source: source.id,
            name: entry.name,
            mtime: s.mtimeMs,
            bytes: s.size,
          });
        }
      } catch (err) {
        const code = errno(err);
        if (code === "ENOENT") state.state = source.own ? "ok" : "missing";
        else if (code === "EPERM" || code === "EACCES") state.state = "denied";
        else state.state = "error";
        if (state.state !== "ok") state.detail = errorMessage(err);
      }
      states.push(state);
    }
    items.sort((a, b) => b.mtime - a.mtime);
    return { items: items.slice(0, limit), sources: states };
  }

  // An id back to a checked image: a name the source lists, read as readChecked does.
  async resolve(id: string): Promise<Resolved> {
    const colon = id.indexOf(":");
    const name = id.slice(colon + 1);
    const source = (await this.sources()).find((s) => s.id === id.slice(0, colon));
    if (colon < 1 || !source || /[/\\\0]/.test(name) || !lists(source, name))
      throw new ImageError(`unknown image ${id}`, "unknown_image");
    return { source, ...(await readChecked(source.dir, name)) };
  }

  // A pasted or captured image, kept in that source's folder. The same image kept again is
  // the one already there, touched so it lists first.
  async save(
    bytes: Uint8Array,
    claimed?: Mime,
    source: OwnSourceId = "pasted",
  ): Promise<{ item: ImageItem; path: string }> {
    checkImage(bytes, claimed);
    const dir = (await this.sources()).find((s) => s.id === source && s.own)?.dir;
    if (!dir) throw new ImageError(`no folder for ${source} images`);
    let path = await this.kept(dir, bytes);
    if (path) {
      const t = new Date(this.now());
      await utimes(path, t, t);
    } else path = await saveImage(dir, bytes, { claimed, now: this.now() });
    const name = basename(path);
    const s = await stat(path);
    const item: ImageItem = {
      id: `${source}:${name}`,
      source,
      name,
      mtime: s.mtimeMs,
      bytes: s.size,
    };
    return { item, path };
  }

  // A pasted or captured image out of the history, checked as a read is. Only the app's own
  // files go: a folder's images are the user's and stay where they are.
  async remove(id: string): Promise<void> {
    const image = await this.resolve(id);
    if (!image.source.own)
      throw new ImageError(`${basename(image.path)} is not a pasted image`, "not_pasted");
    await unlink(image.path).catch((err) => {
      if (errno(err) !== "ENOENT") throw err;
    });
  }

  // The file of the app's own folder with exactly these bytes, if there is one.
  private async kept(dir: string, bytes: Uint8Array): Promise<string | null> {
    const names = await readdir(dir).catch((err) => {
      if (errno(err) === "ENOENT") return [];
      throw err;
    });
    for (const name of names) {
      if (!OURS.test(name)) continue;
      const path = join(dir, name);
      const s = await lstat(path).catch(() => null);
      if (!s?.isFile() || s.size !== bytes.length) continue;
      const same = await Bun.file(path)
        .bytes()
        .then((b) => Buffer.from(b).equals(bytes))
        .catch(() => false);
      if (same) return path;
    }
    return null;
  }

  // The paths to type for these ids, every one resolved before any is used. A pasted or
  // captured image is typed where it is, touched so the week's pruning starts again; any other is copied
  // into the app's folder, so the agent reads a file the app owns under a plain name.
  async forTerminal(ids: string[]): Promise<string[]> {
    const images = await Promise.all(ids.map((id) => this.resolve(id)));
    const paths: string[] = [];
    for (const image of images) {
      if (image.source.own) {
        const t = new Date(this.now());
        await utimes(image.path, t, t);
        paths.push(image.path);
      } else {
        paths.push(await saveImage(this.pastesDir, image.bytes, { now: this.now() }));
      }
    }
    return paths;
  }
}
