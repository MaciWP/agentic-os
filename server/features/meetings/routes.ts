import { Hono } from "hono";
import { MeetingNote, MeetingSync, MeetingsBefore } from "../../../shared/meetings.ts";
import type { MemoryStore } from "../memory/store.ts";
import { meetingNote } from "./note.ts";
import type { MeetingStore } from "./store.ts";

const id = (raw: string) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// The browser syncs what it read from the calendars: a write, so never inside a GET.
export function meetingRoutes({
  meetings,
  memory,
}: {
  meetings: MeetingStore;
  memory: MemoryStore;
}) {
  return (
    new Hono()
      .post("/sync", async (c) => {
        const body = MeetingSync.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
        return c.json({ meetings: meetings.sync(body.data) });
      })
      .get("/open", (c) => {
        const q = MeetingsBefore.safeParse(c.req.query());
        if (!q.success) return c.json({ error: "bad_request", detail: q.error.issues }, 400);
        return c.json({ meetings: meetings.open(q.data.before) });
      })
      .post("/close-before", async (c) => {
        const body = MeetingsBefore.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
        return c.json({ closed: meetings.closeBefore(body.data.before) });
      })
      .post("/:id/close", (c) => {
        const n = id(c.req.param("id"));
        return n ? c.json({ meeting: meetings.close(n) }) : c.json({ error: "bad_request" }, 400);
      })
      // The meeting's note, made once from the template and linked; its doc id after that.
      .post("/:id/note", async (c) => {
        const n = id(c.req.param("id"));
        const body = MeetingNote.safeParse(await c.req.json().catch(() => null));
        if (!n || !body.success) return c.json({ error: "bad_request" }, 400);
        return c.json(await meetingNote(meetings, memory, n, body.data.attendees));
      })
      .post("/:id/reopen", (c) => {
        const n = id(c.req.param("id"));
        return n ? c.json({ meeting: meetings.reopen(n) }) : c.json({ error: "bad_request" }, 400);
      })
  );
}
