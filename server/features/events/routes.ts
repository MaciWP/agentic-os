import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { holdOpen } from "../../deadline.ts";
import type { EventBus } from "./bus.ts";

// The browser's own reconnect delay after a dropped stream.
export const RETRY_MS = 1000;
// A comment every so often: writing to a tab that went away ends its stream.
export const PING_MS = 30_000;

// One held stream per open dashboard. Each event's data is a topic whose list changed.
export function eventRoutes(bus: EventBus) {
  return new Hono().get("/", (c) => {
    // Bun closes an idle request; this one is idle by design.
    holdOpen(c.env, c.req.raw);
    return streamSSE(c, async (stream) => {
      const send = (text: string) => void stream.write(text).catch(() => {});
      const ended = new Promise<void>((resolve) => stream.onAbort(resolve));
      send(`retry: ${RETRY_MS}\n\n`);
      const unsubscribe = bus.subscribe((topic) => send(`data: ${topic}\n\n`));
      const ping = setInterval(() => send(": ping\n\n"), PING_MS);
      await ended;
      clearInterval(ping);
      unsubscribe();
    });
  });
}
