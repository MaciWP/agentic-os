import { Hono } from "hono";
import { z } from "zod";
import { activeTelemetry } from "./index.ts";
import { summary } from "./store.ts";

const Full = z.object({
  minutes: z
    .number()
    .int()
    .min(0)
    .max(24 * 60),
});

// What only the running server knows: its writer's counters, and a flush so a reader sees the
// spans still held in memory. Everything else `aos trace` reads from the file itself.
export const telemetryRoutes = () =>
  new Hono()
    .get("/status", (c) => {
      const t = activeTelemetry();
      if (!t) return c.json({ on: false });
      return c.json({ on: true, path: t.path, stats: t.processor.stats, ...summary(t.db, t.path) });
    })
    // Every request stored whole for a while, for a test; `minutes: 0` ends it.
    .post("/full", async (c) => {
      const body = Full.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
      const t = activeTelemetry();
      if (!t) return c.json({ on: false });
      const { minutes } = body.data;
      t.processor.fullUntil = minutes ? Date.now() + minutes * 60_000 : 0;
      return c.json({ on: true, fullUntil: t.processor.fullUntil || null });
    })
    .post("/flush", (c) => {
      const t = activeTelemetry();
      t?.flush();
      return c.json({ on: t !== null });
    });
