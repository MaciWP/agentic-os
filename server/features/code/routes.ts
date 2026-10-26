import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Deps } from "../../deps.ts";
import { type Places, placeResolver } from "../../place.ts";
import type { EventBus } from "../events/bus.ts";
import { findDefinition, NAME } from "./definition.ts";
import { listAllFiles } from "./files.ts";
import { type CodeStat, listCode, READ_LIMIT, readCode, statCode } from "./read.ts";
import { revealRoutes } from "./reveal.ts";
import { writeCode } from "./write.ts";

const Location = z.string().min(1).max(300);
const Rel = z.string().max(4096);
const TreeQuery = z.object({ location: Location, dir: Rel.default("") });
const FileQuery = z.object({ location: Location, path: Rel.min(1) });
const FilesQuery = z.object({ location: Location });
const DefinitionQuery = FileQuery.extend({ name: z.string().regex(NAME) });
// `base` is the version the editor opened (the file's ETag); `text` the whole new text.
const WriteBody = FileQuery.extend({ text: z.string(), base: z.string().min(1).max(200) });

// A 1 MB file as JSON, every character escaped at worst; write.ts holds the text to 1 MB.
const writeLimit = bodyLimit({
  maxSize: READ_LIMIT * 6 + 4096,
  onError: (c) => c.json({ error: "too_large", detail: "El texto pasa de 1 MB." }, 413),
});

// The images the tile shows as images, by extension; nothing else is served raw.
const IMAGES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};
export const imageType = (path: string) => IMAGES[path.split(".").pop()?.toLowerCase() ?? ""];
export const RAW_LIMIT = 20 * 1024 * 1024;
// An SVG opened on its own runs no script and loads nothing, in the app's origin or out of it.
const RAW_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

// A poll for a file it already has gets a 304 without the file being read: the browser sends
// the ETag back by itself (no-cache keeps it asking every time).
const fresh = (header: string | undefined, file: CodeStat) =>
  header?.split(",").some((v) => v.trim() === file.version) ?? false;

// Below a location the server resolves from its id: read, and save one existing file. Remote
// too: a remote device already runs shells in these checkouts and commits from them. A
// LaunchError (unknown location), a FileError and a GitError reach the app's onError.
export function codeRoutes({ config, terminals }: Deps, places: Places, bus: EventBus) {
  const { place } = placeResolver({ config, terminals }, places);
  const where = async (id: string) => ({ bin: config.git.bin ?? null, ...(await place(id)) });
  const bad = (issues: z.core.$ZodIssue[]) => ({ error: "bad_request", detail: issues });

  return new Hono()
    .get("/tree", async (c) => {
      const q = TreeQuery.safeParse(c.req.query());
      if (!q.success) return c.json(bad(q.error.issues), 400);
      return c.json(await listCode(await where(q.data.location), q.data.dir));
    })
    .get("/file", async (c) => {
      const q = FileQuery.safeParse(c.req.query());
      if (!q.success) return c.json(bad(q.error.issues), 400);
      const file = await statCode(await where(q.data.location), q.data.path);
      c.header("ETag", file.version);
      c.header("Cache-Control", "no-cache");
      if (fresh(c.req.header("If-None-Match"), file)) return c.body(null, 304);
      return c.json(await readCode(file));
    })
    .put("/file", writeLimit, async (c) => {
      const body = WriteBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json(bad(body.error.issues), 400);
      const { location, path, text, base } = body.data;
      return c.json(await writeCode(await where(location), path, text, base));
    })
    .get("/raw", async (c) => {
      const q = FileQuery.safeParse(c.req.query());
      if (!q.success) return c.json(bad(q.error.issues), 400);
      const type = imageType(q.data.path);
      if (!type) return c.json({ error: "not_an_image", detail: "Solo se sirven imágenes." }, 415);
      const file = await statCode(await where(q.data.location), q.data.path);
      if (file.size > RAW_LIMIT) {
        return c.json({ error: "too_large", detail: "La imagen pasa de 20 MB." }, 413);
      }
      const headers = {
        ETag: file.version,
        "Cache-Control": "no-cache",
        "Content-Security-Policy": RAW_CSP,
        "X-Content-Type-Options": "nosniff",
      };
      if (fresh(c.req.header("If-None-Match"), file)) return c.body(null, 304, headers);
      return c.body(Bun.file(file.path).stream(), 200, { ...headers, "Content-Type": type });
    })
    .get("/files", async (c) => {
      const q = FilesQuery.safeParse(c.req.query());
      if (!q.success) return c.json(bad(q.error.issues), 400);
      return c.json(await listAllFiles(await where(q.data.location)));
    })
    .get("/definition", async (c) => {
      const q = DefinitionQuery.safeParse(c.req.query());
      if (!q.success) return c.json(bad(q.error.issues), 400);
      const { location, path, name } = q.data;
      return c.json(await findDefinition(await where(location), path, name));
    })
    .route("/reveal", revealRoutes(bus, where));
}
