import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../db.ts";
import type { TerminalInfo } from "../terminals/contract.ts";
import { ObjectiveStore } from "./store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const terminal = (over: Partial<TerminalInfo> = {}) =>
  ({
    id: "t1",
    harness: "claude",
    ticket: null,
    agent: { sessionId: null, state: "needs_you" },
    ...over,
  }) as TerminalInfo;

test("a goal, a terminal's choice and filed sessions survive reopening the database", () => {
  const dir = mkdtempSync(join(tmpdir(), "objectives-"));
  dirs.push(dir);
  const path = join(dir, "db.sqlite");
  let db = openDb(path);
  const store = new ObjectiveStore(db);
  const goal = store.createGoal("Refactor the PTY host");
  store.choose(terminal({ agent: { sessionId: "s1", state: "needs_you" } }), {
    objective: goal.id as number,
  });
  db.close();

  db = openDb(path);
  const again = new ObjectiveStore(db);
  expect(again.list()).toEqual([goal]);
  expect(again.of(terminal())).toEqual(goal);
  expect(again.sessions().get("claude:s1")).toEqual(goal);
  db.close();
});

test("with no choice a terminal works on its launch ticket; the user can clear or restore it", () => {
  const store = new ObjectiveStore(openDb(":memory:"));
  const launched = terminal({ ticket: "ABC-1" });
  expect(store.decorate(launched)).toMatchObject({
    ticket: "ABC-1",
    objective: { kind: "ticket", id: null, ticket: "ABC-1" },
  });
  store.choose(launched, { none: true });
  expect(store.decorate(launched)).toMatchObject({ ticket: null, objective: null });
  store.choose(launched, { ticket: "ABC-2" });
  expect(store.decorate(launched)).toMatchObject({ ticket: "ABC-2" });
  store.choose(launched, { launch: true });
  expect(store.decorate(launched)).toMatchObject({ ticket: "ABC-1" });
});

test("a session keeps the objective it ran under when the terminal's choice changes later", () => {
  const store = new ObjectiveStore(openDb(":memory:"));
  const a = store.createGoal("First");
  const b = store.createGoal("Second");
  const t = terminal({ harness: "codex" });
  store.choose(t, { objective: a.id as number });
  store.freeze(t, "s1");
  store.freeze(t, "s1");
  store.choose(
    { ...t, agent: { sessionId: "s2", state: "working" } },
    { objective: b.id as number },
  );
  store.freeze(t, "s3");
  const filed = store.sessions();
  expect(filed.get("codex:s1")).toEqual(a);
  expect(filed.get("codex:s2")).toEqual(b);
  expect(filed.get("codex:s3")).toEqual(b);
  expect(filed.has("claude:s1")).toBe(false);
});

test("a launch ticket is filed by its own key; a terminal with no objective files nothing", () => {
  const store = new ObjectiveStore(openDb(":memory:"));
  store.freeze(terminal({ ticket: "ABC-1" }), "s1");
  store.freeze(terminal({ id: "t2" }), "s2");
  expect(store.sessions().get("claude:s1")).toMatchObject({ kind: "ticket", ticket: "ABC-1" });
  expect(store.sessions().size).toBe(1);
});

test("a closed goal leaves the list, keeps its sessions and cannot be chosen again", () => {
  const store = new ObjectiveStore(openDb(":memory:"));
  const goal = store.createGoal("Done soon");
  const t = terminal({ agent: { sessionId: "s1", state: "needs_you" } });
  store.choose(t, { objective: goal.id as number });
  const closed = store.close(goal.id as number);
  expect(closed).toMatchObject({ kind: "goal", closedAt: expect.any(String) });
  expect(store.list()).toEqual([]);
  expect(store.sessions().get("claude:s1")).toEqual(closed);
  expect(() => store.choose(terminal({ id: "t2" }), { objective: goal.id as number })).toThrow(
    "closed",
  );
  expect(() => store.close(999)).toThrow("not_found");
});

test("every change tells the subscribers", () => {
  const store = new ObjectiveStore(openDb(":memory:"));
  let calls = 0;
  store.subscribe(() => calls++);
  const goal = store.createGoal("Watched");
  store.choose(terminal(), { objective: goal.id as number });
  store.close(goal.id as number);
  expect(calls).toBe(3);
});

test("a day's tasks: open goals carry over, a goal done that day stays on it and leaves the next", () => {
  const db = openDb(":memory:");
  const store = new ObjectiveStore(db);
  const at = (id: number | null, created: string, closed: string | null) =>
    db.run("UPDATE objectives SET created_at = ?, closed_at = ? WHERE id = ?", [
      created,
      closed,
      id,
    ]);
  const carried = store.createGoal("Carried");
  const done = store.createGoal("Done on day 1");
  const later = store.createGoal("Created on day 2");
  at(carried.id, "2026-10-01T08:00:00.000Z", null);
  at(done.id, "2026-10-01T09:00:00.000Z", "2026-10-01T17:00:00.000Z");
  at(later.id, "2026-10-02T09:00:00.000Z", null);
  db.run("INSERT INTO objectives (kind, ticket, created_at) VALUES ('ticket', 'AB-1', ?)", [
    "2026-10-01T08:00:00.000Z",
  ]);

  const day1 = store.tasks("2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z", "2026-10-01");
  expect(day1.map((t) => [t.title, t.closedAt !== null])).toEqual([
    ["Carried", false],
    ["Done on day 1", true],
  ]);
  const day2 = store.tasks("2026-10-02T00:00:00.000Z", "2026-10-03T00:00:00.000Z", "2026-10-02");
  expect(day2.map((t) => t.title)).toEqual(["Carried", "Created on day 2"]);

  expect(store.reopen(done.id as number)).toMatchObject({ closedAt: null });
  expect(
    store.tasks("2026-10-02T00:00:00.000Z", "2026-10-03T00:00:00.000Z", "2026-10-02"),
  ).toHaveLength(3);
  expect(() => store.reopen(999)).toThrow("not_found");
});

test("a task due on a later day waits for it, and its source makes it once", () => {
  const store = new ObjectiveStore(openDb(":memory:"));
  const day = (d: string) =>
    store.tasks(`${d}T00:00:00.000Z`, "2999-01-01T00:00:00.000Z", d).map((t) => t.title);
  store.addTask({ title: "Llamar", dueOn: "2026-10-20", dueHm: "16:00", priority: 1 });
  const mail = { title: "Responder", source: "mail:outlook", sourceKey: "<a@example.test>" };
  const first = store.addTask(mail);
  expect(store.addTask({ ...mail, title: "Otra vez" }).id).toBe(first.id);

  expect(day("2026-10-19")).toEqual(["Responder"]);
  expect(day("2026-10-21")).toEqual(["Llamar", "Responder"]);
  const [llamar] = store.tasks(
    "2026-10-20T00:00:00.000Z",
    "2999-01-01T00:00:00.000Z",
    "2026-10-20",
  );
  expect(llamar).toMatchObject({ dueOn: "2026-10-20", dueHm: "16:00", priority: 1, position: 1 });
});

test("a checklist sent twice makes each line once", () => {
  const store = new ObjectiveStore(openDb(":memory:"));
  const lines = ["a", "b"].map((k) => ({ title: k, source: "note:n1", sourceKey: k }));
  const once = store.addTasks(lines);
  expect(store.addTasks(lines).map((t) => t.id)).toEqual(once.map((t) => t.id));
});

test("a patch edits a goal; clearing its day clears its time; a ticket is not a task", () => {
  const store = new ObjectiveStore(openDb(":memory:"));
  const t = store.addTask({ title: "Mover", dueOn: "2026-10-20", dueHm: "09:00" });
  expect(store.patchTask(t.id, { position: 0.5, priority: 1 })).toMatchObject({
    position: 0.5,
    priority: 1,
    dueHm: "09:00",
  });
  expect(store.patchTask(t.id, { dueOn: null })).toMatchObject({ dueOn: null, dueHm: null });
  store.choose(terminal(), { ticket: "AB-1" });
  const ticket = store.list().find((o) => o.kind === "ticket");
  expect(() => store.patchTask(ticket?.id as number, { title: "x" })).toThrow("not_found");
});
