import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { SourceId } from "./sources.ts";
import type { MemoryStore } from "./store.ts";

const Id = z.string().min(1).max(1024);
const Body = z.string();
const CreateBody = z.object({ source: z.string().max(40), name: z.string().max(200), body: Body });
const UpdateBody = z.object({ id: Id, body: Body, mtime: z.number().finite() });
const DeleteBody = z.object({
  id: Id,
  mtime: z.number().finite(),
  version: z.string().regex(/^[a-f0-9]{64}$/),
});

// A JSON-escaped 1 MB document stays well under this; anything larger is not a note.
const limit = bodyLimit({
  maxSize: 8 << 20,
  onError: (c) => c.json({ error: "too_large", detail: "request body too large" }, 413),
});

export function memoryRoutes(store: MemoryStore) {
  const known = (id: string) => store.source(id) !== undefined;
  const parse = async <T>(schema: z.ZodType<T>, req: Request) =>
    schema.safeParse(await req.json().catch(() => null));

  return new Hono()
    .get("/sources", async (c) => c.json({ sources: await store.listSources() }))
    .get("/docs", async (c) => {
      const source = c.req.query("source") ?? "";
      if (!known(source)) return c.json({ error: "not_found", detail: "no such source" }, 404);
      return c.json({ docs: await store.list(source as SourceId) });
    })
    .get("/doc", async (c) => c.json({ doc: await store.get(c.req.query("id") ?? "") }))
    .get("/search", async (c) => c.json({ hits: await store.search(c.req.query("q") ?? "") }))
    .get("/bar", async (c) => c.json({ buttons: await store.bar() }))
    .post("/doc", limit, async (c) => {
      const body = await parse(CreateBody, c.req.raw);
      if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
      const { source, name, body: text } = body.data;
      return c.json({ doc: await store.create(source, name, text) }, 201);
    })
    .put("/doc", limit, async (c) => {
      const body = await parse(UpdateBody, c.req.raw);
      if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
      const { id, body: text, mtime } = body.data;
      return c.json({ doc: await store.update(id, text, mtime) });
    })
    .delete("/doc", async (c) => {
      const body = await parse(DeleteBody, c.req.raw);
      if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
      const recovery = await store.remove(body.data.id, body.data.mtime, body.data.version);
      return c.json({ ok: true, recovery });
    });
}
