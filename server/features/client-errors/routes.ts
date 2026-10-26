import { Hono } from "hono";
import { z } from "zod";
import { log } from "../../log.ts";

// What a tab reports when its own code fails: an uncaught error, a rejected promise nobody
// handled, or a view that crashed while rendering. It lands in data/server.log as a `web` line,
// next to the request lines, so a failure seen in the browser can be placed in time.
export const ClientError = z.object({
  kind: z.enum(["error", "rejection", "render"]),
  message: z.string().min(1).max(500),
  stack: z.string().max(4000).optional(),
  // The page's path, without its query (log.ts strips any URL's query too).
  path: z.string().max(200),
  // The x-request-id of the failed call behind it, when there was one.
  request: z.string().max(64).optional(),
});
export type ClientError = z.infer<typeof ClientError>;

// The same message again within this window adds no line: a render loop or a poll that fails
// every few seconds would otherwise fill the log.
const REPEAT_MS = 60_000;
const MAX_KEPT = 200;

export function clientErrorRoutes(now: () => number = Date.now) {
  const seen = new Map<string, number>();
  return new Hono().post("/", async (c) => {
    const body = ClientError.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
    const { kind, message, stack, path, request } = body.data;
    const key = `${kind} ${message}`;
    const last = seen.get(key);
    if (last !== undefined && now() - last < REPEAT_MS) return c.body(null, 204);
    if (seen.size >= MAX_KEPT) seen.clear();
    seen.set(key, now());
    log("web").error(`${kind}: ${message}`, { path, request, stack });
    return c.body(null, 204);
  });
}
