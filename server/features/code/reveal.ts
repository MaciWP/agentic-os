import { Hono } from "hono";
import { z } from "zod";
import type { EventBus } from "../events/bus.ts";
import { type CodeWhere, statCode } from "./read.ts";

// A file asked for from outside the page (Claude Code's dock buttons): the open dashboards
// open it in their code tile, as the git diff's "Abrir en Código" does. Only the last ask is
// kept, for REVEAL_TTL_MS: a dashboard that loads soon after (none was open) still opens it,
// and one that loads later does not. Reading it changes nothing, so a refetch or a second tab
// is harmless; each ask has its own id, so a page opens it once.
export const REVEAL_TTL_MS = 30_000;

const RevealBody = z.object({
  location: z.string().min(1).max(300),
  path: z.string().min(1).max(4096),
  line: z.number().int().positive().optional(),
});

type Reveal = { id: string; location: string; path: string; line: number | null };

export function revealRoutes(
  bus: EventBus,
  where: (location: string) => Promise<CodeWhere>,
  now: () => number = Date.now,
) {
  let last: { reveal: Reveal; at: number } | null = null;
  return new Hono()
    .get("/", (c) =>
      c.json(last && now() - last.at < REVEAL_TTL_MS ? (last.reveal as Reveal | null) : null),
    )
    .post("/", async (c) => {
      const body = RevealBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
      const { location, path, line } = body.data;
      // The location's own checks: an unknown id, a path out of it or no file reach onError.
      const file = await statCode(await where(location), path);
      const reveal = { id: crypto.randomUUID(), location, path: file.rel, line: line ?? null };
      last = { reveal, at: now() };
      bus.publish("reveal");
      // No dashboard holds the stream: the caller opens one, which reads the ask as it loads.
      return c.json({ id: reveal.id, delivered: bus.listening > 0 });
    });
}
