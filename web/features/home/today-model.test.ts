import { describe, expect, test } from "bun:test";
import type { AgendaEvent } from "../../../server/features/google/client.ts";
import type { Meeting } from "../../../shared/meetings.ts";
import type { Task } from "../../../shared/objectives.ts";
import {
  carried,
  checklist,
  type Day,
  localDay,
  mergedAgenda,
  moved,
  pendingLines,
  placedBefore,
  syncBody,
  taskFromMail,
  tasksFromNote,
  ticketOrder,
  timedRows,
  untimedRows,
} from "./today-model.ts";

// bun test runs in UTC; these pin a zone with a DST change to catch day maths done in UTC.
// The saved zone comes back as it was, never unset.
const inZone = <T>(tz: string, fn: () => T): T => {
  const saved = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    process.env.TZ = saved;
  }
};

describe("the local day", () => {
  test("runs from local midnight to the next one, across a DST change", () => {
    inZone("Europe/Madrid", () => {
      const now = new Date("2026-10-25T10:00:00+01:00");
      expect(localDay(0, now)).toEqual({
        from: "2026-10-24T22:00:00.000Z",
        to: "2026-10-25T23:00:00.000Z",
        day: "2026-10-25",
      });
      expect(localDay(-1, now).to).toBe("2026-10-24T22:00:00.000Z");
    });
  });

  test("a task is carried by whole local days since the day it was created", () => {
    inZone("Europe/Madrid", () => {
      const today = localDay(0, new Date("2026-10-14T09:00:00+02:00")).from;
      expect(carried("2026-10-14T06:00:00.000Z", today)).toBeNull();
      expect(carried("2026-10-13T21:30:00.000Z", today)).toBe("desde ayer");
      expect(carried("2026-10-11T08:00:00.000Z", today)).toBe("desde hace 3 días");
    });
  });
});

// The tests below run in UTC, so the local day is the UTC one.
const DAY: Day = {
  from: "2026-10-16T00:00:00.000Z",
  to: "2026-10-17T00:00:00.000Z",
  day: "2026-10-16",
};

const event = (over: Partial<AgendaEvent>): AgendaEvent => ({
  source: "outlook",
  id: "E",
  occurrence: null,
  title: "Daily",
  start: "2026-10-16T09:00:00Z",
  end: "2026-10-16T09:15:00Z",
  allDay: false,
  location: null,
  meet: null,
  link: null,
  attendees: [],
  ...over,
});

const meeting = (over: Partial<Meeting>): Meeting => ({
  id: 1,
  source: "outlook",
  eventKey: "E",
  occurrence: null,
  title: "Daily",
  start: "2026-10-16T09:00:00.000Z",
  end: "2026-10-16T09:15:00.000Z",
  allDay: false,
  noteId: null,
  closedAt: null,
  ...over,
});

const task = (id: number, over: Partial<Task> = {}): Task => ({
  id,
  title: `t${id}`,
  createdAt: "2026-10-16T07:00:00.000Z",
  closedAt: null,
  dueOn: null,
  dueHm: null,
  priority: 0,
  position: id,
  about: null,
  source: null,
  sourceKey: null,
  ...over,
});

const DAY_WINDOW = { from: DAY.from, to: DAY.to };

describe("the sync body", () => {
  test("names only the calendars that answered, so a failed one never reads as cancelled", () => {
    expect(syncBody(DAY, {})).toEqual({ ...DAY_WINDOW, sources: [], events: [] });
    const body = syncBody(DAY, { outlook: [event({ occurrence: "2026-10-16T09:00:00Z" })] });
    expect(body.sources).toEqual(["outlook"]);
    expect(body.events[0]).toMatchObject({ source: "outlook", eventKey: "E" });
    expect(syncBody(DAY, { google: [] }).sources).toEqual(["google"]);
  });
});

describe("timed rows", () => {
  test("join each event to its meeting, an empty occurrence matching a null one", () => {
    const rows = timedRows(
      DAY,
      [event({ source: "google" })],
      [meeting({ id: 7, source: "google", occurrence: null })],
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "meeting", meeting: { id: 7 }, at: "09:00" });
  });

  test("keep a meeting whose calendar failed this time, and only today's", () => {
    const rows = timedRows(
      DAY,
      [],
      [meeting({ id: 2 }), meeting({ id: 3, eventKey: "Y", start: "2026-10-15T09:00:00.000Z" })],
      [],
    );
    expect(rows.map((r) => r.kind === "meeting" && r.meeting?.id)).toEqual([2]);
  });

  test("an event shows before its sync answers, and all-day goes first, tasks by their time", () => {
    const rows = timedRows(
      DAY,
      [
        event({ id: "late", start: "2026-10-16T15:00:00Z" }),
        event({ id: "all", allDay: true, start: "2026-10-16" }),
      ],
      [],
      [task(1, { dueOn: "2026-10-16", dueHm: "12:30" }), task(2, { dueOn: "2026-10-16" })],
    );
    expect(rows.map((r) => r.key)).toEqual(["outlook|all|", "task:1", "outlook|late|"]);
    expect(rows[2]).toMatchObject({ meeting: null });
  });
});

describe("untimed rows", () => {
  test("open before done, priority first, then the user's order, with what each carries", () => {
    const rows = untimedRows(DAY, [
      task(1, { closedAt: "2026-10-16T08:00:00.000Z" }),
      task(2, { position: 5 }),
      task(3, { position: 9, priority: 1 }),
      task(4, { position: 1, dueOn: "2026-10-14" }),
      task(5, { position: 2, createdAt: "2026-10-15T08:00:00.000Z" }),
      task(6, { dueOn: "2026-10-16", dueHm: "10:00" }),
    ]);
    expect(rows.map((r) => r.task.id)).toEqual([3, 4, 5, 2, 1]);
    expect(rows.map((r) => r.note)).toEqual([null, "vencida", "desde ayer", null, null]);
  });
});

describe("the user's order", () => {
  const rows = [task(1, { position: 1 }), task(2, { position: 2 }), task(3, { position: 4 })];

  test("one step lands halfway between the new neighbours, or past the end", () => {
    expect(moved(rows, 2, -1)).toBe(1.5);
    expect(moved(rows, 0, 1)).toBe(3);
    expect(moved(rows, 1, 1)).toBe(4.5);
    expect(moved(rows, 0, -1)).toBeNull();
  });

  test("never across a priority or into the done ones", () => {
    expect(moved([task(1, { priority: 1 }), task(2)], 1, -1)).toBeNull();
    expect(moved([task(1), task(2, { closedAt: "x" })], 0, 1)).toBeNull();
  });

  test("a drop goes just before its target", () => {
    expect(placedBefore(rows, 2)).toBe(1.5);
    expect(placedBefore(rows, 1)).toBe(0);
  });
});

describe("a mail as a task", () => {
  test("reads its subject by the task rules and links the mail", () => {
    const g = taskFromMail(
      { account: "outlook", key: "abc@example.test", subject: "Revisar contrato mañana urgente" },
      new Date(2026, 9, 16, 9),
    );
    expect(g).toMatchObject({
      title: "Revisar contrato urgente",
      dueOn: "2026-10-17",
      priority: 1,
      source: "mail:outlook",
      sourceKey: "abc@example.test",
    });
    expect(taskFromMail({ account: "gmail", key: "t1", subject: null }).title).toBe("(sin asunto)");
  });
});

describe("both calendars on the summary line", () => {
  const ok = (events: AgendaEvent[]) => ({ isPending: false, isError: false, data: { events } });
  const off = { isPending: false, isError: false, data: { disabled: true as const } };
  const failed = { isPending: false, isError: true };

  test("merge by instant, whatever the offset", () => {
    const merged = mergedAgenda(
      ok([event({ id: "g", source: "google", start: "2026-10-16T10:30:00+02:00" })]),
      ok([event({ id: "o", start: "2026-10-16T09:00:00Z" })]),
    );
    expect(merged.data && "events" in merged.data && merged.data.events.map((e) => e.id)).toEqual([
      "g",
      "o",
    ]);
  });

  test("one off or failed still shows the other; all failed is an error; both off is off", () => {
    expect(mergedAgenda(ok([event({})]), off).data).toEqual({ events: [event({})] });
    expect(mergedAgenda(failed, ok([])).isError).toBe(false);
    expect(mergedAgenda(failed, off).isError).toBe(true);
    expect(mergedAgenda(off, off).data).toEqual({ disabled: true });
  });
});

test("tickets: in progress first, nothing done", () => {
  const t = (key: string, category: string) => ({ key, status: { category } });
  expect(
    ticketOrder([t("A", "new"), t("B", "done"), t("C", "indeterminate")]).map((x) => x.key),
  ).toEqual(["C", "A"]);
});

describe("a meeting note's checklist", () => {
  const body = [
    "# Reunión · Comité",
    "## Tareas",
    "- [ ] Enviar acta mañana",
    "- [x] Reservar sala",
    "  * [ ]   Revisar  ABC-12 !",
    "- [ ] ",
    "- [ ] enviar acta MAÑANA",
    "texto - [ ] suelto",
  ].join("\n");

  test("reads the open lines with text, nothing ticked or empty", () => {
    expect(checklist(body)).toEqual([
      "Enviar acta mañana",
      "Revisar  ABC-12 !",
      "enviar acta MAÑANA",
    ]);
  });

  test("a line already made, or written twice, is pending once at most", () => {
    const lines = checklist(body);
    expect(pendingLines(lines, [])).toEqual(["Enviar acta mañana", "Revisar  ABC-12 !"]);
    expect(pendingLines(lines, [{ sourceKey: "enviar acta mañana" }])).toEqual([
      "Revisar  ABC-12 !",
    ]);
  });

  test("each line becomes a task of the meeting, read by the task rules", () => {
    const [a, b] = tasksFromNote(
      7,
      ["Enviar acta mañana", "Revisar  ABC-12 !"],
      new Date(2026, 9, 16, 9),
    );
    expect(a).toMatchObject({
      title: "Enviar acta",
      dueOn: "2026-10-17",
      source: "meeting:7",
      sourceKey: "enviar acta mañana",
    });
    expect(b).toMatchObject({ priority: 1, about: "ABC-12", sourceKey: "revisar abc-12 !" });
  });
});
