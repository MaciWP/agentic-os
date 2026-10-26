import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { WorkAck, WorkResponse, WorkSession, WorkTicket } from "../../../shared/workboard.ts";
import { errorMessage } from "../../error-message.ts";
import type { WorkboardStore } from "./store.ts";

type Deps = {
  store: WorkboardStore;
  context(ticket: string | null, cwd: string): Promise<unknown>;
  actor(id: string | undefined, input?: WorkSession): Promise<string>;
  // Whether a former owner let go of the session: a resume or restart moves it to a new terminal.
  released?(actor: string, sessionId: string): Promise<boolean>;
};
export function workboardRoutes({ store, context, actor, released }: Deps) {
  return new Hono()
    .use("*", bodyLimit({ maxSize: 64 * 1024 }))
    .get("/context", async (c) => {
      const ticket = c.req.query("ticket") || null;
      if (ticket && !WorkTicket.safeParse(ticket).success)
        return c.json({ error: "invalid_ticket" }, 400);
      const cwd = c.req.query("cwd") ?? "";
      if (cwd.length > 4096 || cwd.includes("\0")) return c.json({ error: "invalid_cwd" }, 400);
      const result = await context(ticket, cwd);
      const published = (await store.list()).filter((s) =>
        ticket ? s.ticket === ticket : s.cwd === cwd,
      );
      return c.json({ version: 1, context: result, published });
    })
    .post("/session", async (c) => {
      const raw = await c.req.text();
      if (raw.length > 64 * 1024) return c.json({ error: "too_large" }, 413);
      const input = WorkSession.safeParse(
        await Promise.resolve()
          .then(() => JSON.parse(raw))
          .catch(() => null),
      );
      if (!input.success) return c.json({ error: "invalid_session" }, 400);
      let owner: string;
      try {
        owner = await actor(c.req.header("x-aos-agent-id"), input.data);
      } catch {
        return c.json({ error: "unknown_actor" }, 403);
      }
      // Outside the try: a store or PTY host that fails here is a server failure (503/500), not
      // a conflict over who owns the session.
      const previous = (await store.list()).find((s) => s.sessionId === input.data.sessionId);
      const from =
        previous &&
        previous.actor !== owner &&
        (await released?.(previous.actor, input.data.sessionId))
          ? previous.actor
          : undefined;
      try {
        await store.publish(owner, input.data, from);
        return c.json({ ok: true });
      } catch (err) {
        return c.json({ error: "publish_conflict", detail: errorMessage(err) }, 409);
      }
    })
    .post("/response", async (c) => {
      const input = WorkResponse.safeParse(await c.req.json().catch(() => null));
      if (!input.success) return c.json({ error: "invalid_response" }, 400);
      try {
        await store.respond(input.data);
        return c.json({ ok: true });
      } catch (err) {
        return c.json({ error: "response_conflict", detail: errorMessage(err) }, 409);
      }
    })
    .post("/ack", async (c) => {
      const input = WorkAck.safeParse(await c.req.json().catch(() => null));
      if (!input.success) return c.json({ error: "invalid_ack" }, 400);
      let owner: string;
      try {
        owner = await actor(c.req.header("x-aos-agent-id"));
      } catch {
        return c.json({ error: "unknown_actor" }, 403);
      }
      try {
        await store.ack(owner, input.data);
        return c.json({ ok: true });
      } catch (err) {
        return c.json({ error: "ack_conflict", detail: errorMessage(err) }, 409);
      }
    });
}
