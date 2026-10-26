import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Meeting, MeetingSync } from "../../../shared/meetings.ts";
import { SERVER_ERRORS } from "../../app-errors.ts";
import { openDb } from "../../db.ts";
import { errorHandler } from "../../errors.ts";
import { memorySources } from "../memory/sources.ts";
import { MemoryStore } from "../memory/store.ts";
import { noteName } from "./note.ts";
import { meetingRoutes } from "./routes.ts";
import { MeetingStore } from "./store.ts";

const DAY = { from: "2026-10-16T00:00:00.000Z", to: "2026-10-17T00:00:00.000Z" };
const event = (eventKey: string, start: string, over: Partial<MeetingSync["events"][0]> = {}) => ({
  source: "outlook" as const,
  eventKey,
  occurrence: start,
  title: eventKey,
  start,
  end: start.replace(/T(\d\d)/, (_, h) => `T${String(Number(h) + 1).padStart(2, "0")}`),
  allDay: false,
  ...over,
});

test("a sync keeps the user's close and follows the calendar's title and time", () => {
  const store = new MeetingStore(openDb(":memory:"));
  const [m] = store.sync({
    ...DAY,
    sources: ["outlook"],
    events: [event("A", "2026-10-16T09:00:00Z")],
  });
  store.close(m?.id as number);
  const [again] = store.sync({
    ...DAY,
    sources: ["outlook"],
    events: [event("A", "2026-10-16T09:00:00Z", { title: "Renamed" })],
  });
  expect(again).toMatchObject({ id: m?.id, title: "Renamed" });
  expect(again?.closedAt).not.toBeNull();
});

test("a series repeats its id: each occurrence is its own meeting", () => {
  const store = new MeetingStore(openDb(":memory:"));
  const out = store.sync({
    from: "2026-10-16T00:00:00.000Z",
    to: "2026-10-18T00:00:00.000Z",
    sources: ["outlook"],
    events: [event("S", "2026-10-17T09:00:00Z"), event("S", "2026-10-16T09:00:00Z")],
  });
  expect(out.map((m) => m.start)).toEqual(["2026-10-16T09:00:00.000Z", "2026-10-17T09:00:00.000Z"]);
});

test("a meeting gone from a calendar that answered is dropped, unless it has a note or its calendar failed", () => {
  const db = openDb(":memory:");
  const store = new MeetingStore(db);
  const both = [
    event("gone", "2026-10-16T09:00:00Z"),
    event("noted", "2026-10-16T10:00:00Z"),
    event("g", "2026-10-16T11:00:00Z", { source: "google", occurrence: null }),
  ];
  const [, noted] = store.sync({ ...DAY, sources: ["outlook", "google"], events: both });
  db.run("UPDATE meetings SET note_id = 'n1' WHERE id = ?", [noted?.id as number]);
  store.sync({ ...DAY, sources: ["outlook"], events: [] });
  expect(store.open("2026-10-17T00:00:00.000Z").map((m) => m.eventKey)).toEqual(["noted", "g"]);
});

test("the carry-over: open meetings of earlier days, closed one by one or all at once", () => {
  const store = new MeetingStore(openDb(":memory:"));
  store.sync({
    from: "2026-10-14T00:00:00.000Z",
    to: "2026-10-17T00:00:00.000Z",
    sources: ["outlook"],
    events: [
      event("mon", "2026-10-14T09:00:00Z"),
      event("tue", "2026-10-15T09:00:00Z"),
      event("today", "2026-10-16T09:00:00Z"),
      event("allday", "2026-10-15", { end: "2026-10-16", allDay: true, occurrence: null }),
    ],
  });
  const before = "2026-10-16T00:00:00.000Z";
  expect(store.open(before).map((m) => m.eventKey)).toContain("allday");
  expect(store.closeBefore(before)).toBe(3);
  expect(store.open(before)).toEqual([]);
  expect(store.open("2026-10-17T00:00:00.000Z").map((m) => m.eventKey)).toEqual(["today"]);
});

// The routes over a real note store in a throwaway folder.
function routes() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "aos-meetings-")));
  const roots = { home: join(dir, "home"), dataDir: join(dir, "data"), repos: [] };
  const db = openDb(":memory:");
  const meetings = new MeetingStore(db);
  const memory = new MemoryStore(db, memorySources(roots), roots.dataDir);
  const app = new Hono()
    .route("/", meetingRoutes({ meetings, memory }))
    .onError(errorHandler(SERVER_ERRORS));
  return {
    app,
    memory,
    notes: join(roots.dataDir, "notes"),
    done: () => rmSync(dir, { recursive: true }),
  };
}

test("routes: sync, open, close, close-before and bad input", async () => {
  const { app, done } = routes();
  const post = (path: string, body?: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const synced = await post("/sync", {
    ...DAY,
    sources: ["outlook"],
    events: [event("A", "2026-10-16T09:00:00Z")],
  });
  const {
    meetings: [m],
  } = (await synced.json()) as { meetings: { id: number }[] };
  expect((await post(`/${m?.id}/close`)).status).toBe(200);
  expect((await post(`/${m?.id}/reopen`)).status).toBe(200);
  expect((await post("/999/close")).status).toBe(404);
  expect((await post("/sync", { ...DAY, sources: ["teams"], events: [] })).status).toBe(400);
  expect((await app.request("/open?before=nope")).status).toBe(400);
  const open = await app.request("/open?before=2026-10-17T00:00:00.000Z");
  expect(((await open.json()) as { meetings: unknown[] }).meetings).toHaveLength(1);
  expect(
    await (await post("/close-before", { before: "2026-10-17T00:00:00.000Z" })).json(),
  ).toEqual({ closed: 1 });
  done();
});

test("a meeting's note is made once from the template, found again, and remade if deleted", async () => {
  const { app, memory, notes, done } = routes();
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const synced = await post("/sync", {
    ...DAY,
    sources: ["outlook"],
    events: [event("A", "2026-10-16T09:00:00Z", { title: "Comité" })],
  });
  const [m] = ((await synced.json()) as { meetings: Meeting[] }).meetings;
  const id = m?.id as number;
  const first = await post(`/${id}/note`, { attendees: ["Ana", "Luis"] });
  const { noteId, meeting } = (await first.json()) as { noteId: string; meeting: Meeting };
  expect(meeting.noteId).toBe(noteId);
  expect(readdirSync(notes)).toEqual([`${noteName(meeting)}.md`]);
  const body = (await memory.get(noteId)).body;
  expect(body).toStartWith("# Reunión · Comité · ");
  expect(body).toContain("- Ana\n- Luis");
  expect(body).toContain("## Tareas\n- [ ] ");

  const again = (await (await post(`/${id}/note`, { attendees: [] })).json()) as { noteId: string };
  expect(again.noteId).toBe(noteId);

  rmSync(join(notes, readdirSync(notes)[0] as string));
  const remade = (await (await post(`/${id}/note`, { attendees: [] })).json()) as {
    noteId: string;
  };
  expect(remade.noteId).toBe(noteId);
  expect(readdirSync(notes)).toHaveLength(1);

  // A note of that name already in Notas, not linked yet (a second sync row of the same
  // event): it is found, never overwritten.
  const synced2 = await post("/sync", {
    ...DAY,
    sources: ["outlook"],
    events: [event("B", "2026-10-16T11:00:00Z")],
  });
  const b = ((await synced2.json()) as { meetings: Meeting[] }).meetings.find(
    (x) => x.eventKey === "B",
  ) as Meeting;
  const mine = await memory.create("notes", noteName(b), "mine\n");
  const found = (await (await post(`/${b.id}/note`, { attendees: [] })).json()) as {
    noteId: string;
  };
  expect(found.noteId).toBe(mine.id);
  expect((await memory.get(mine.id)).body).toBe("mine\n");

  expect((await post("/999/note", { attendees: [] })).status).toBe(404);
  expect((await post(`/${id}/note`, { attendees: "Ana" })).status).toBe(400);
  done();
});

test("a time with an offset is stored as UTC, so a late meeting stays on its own day", () => {
  const store = new MeetingStore(openDb(":memory:"));
  // 23:30 in Madrid is 21:30 UTC: inside a local day that runs 22:00 → 22:00 UTC.
  const local = { from: "2026-10-15T22:00:00.000Z", to: "2026-10-16T22:00:00.000Z" };
  const late = event("late", "2026-10-16T23:30:00+02:00", {
    source: "google",
    end: "2026-10-17T00:15:00+02:00",
  });
  const sync = () => store.sync({ ...local, sources: ["google"], events: [late] });
  expect(sync().map((m) => m.start)).toEqual(["2026-10-16T21:30:00.000Z"]);
  // A second read of the same day finds it inside the window and keeps it.
  expect(sync()).toHaveLength(1);
  expect(store.open(local.to)).toHaveLength(1);
});

test("a sync where no calendar answered drops nothing and answers what the day kept", () => {
  const store = new MeetingStore(openDb(":memory:"));
  store.sync({ ...DAY, sources: ["outlook"], events: [event("kept", "2026-10-16T09:00:00Z")] });
  const out = store.sync({ ...DAY, sources: [], events: [] });
  expect(out.map((m) => m.eventKey)).toEqual(["kept"]);
});
