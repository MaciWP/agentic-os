import { describe, expect, test } from "bun:test";
import { ZodError } from "zod";
import type { SharedMesa, WorkspaceCommand, WorkspaceIntent } from "../../../shared/workspace.ts";
import { openDb } from "../../db.ts";
import { applyIntent, WorkspaceConflict, WorkspaceStore } from "./store.ts";

test("an import starts the shared Mesas once; a retried id replays it, a reused one conflicts", () => {
  const db = openDb(":memory:");
  let events = 0;
  const a = new WorkspaceStore(db, () => {
    expect(db.inTransaction).toBe(false);
    events++;
  });
  const b = new WorkspaceStore(db);
  const seed = {
    requestId: crypto.randomUUID(),
    expectedRevision: 0,
    action: { kind: "import" as const, mesas: [{ id: "one", name: "Mesa 1", ids: ["t1"] }] },
  };
  const first = a.apply(seed);
  expect(b.read()).toEqual(first);
  expect(a.apply(seed)).toEqual(first);
  expect(events).toBe(1);
  const again = (expectedRevision: number) => () =>
    b.apply({ ...seed, requestId: crypto.randomUUID(), expectedRevision });
  expect(again(0)).toThrow("workspace_changed");
  expect(again(1)).toThrow("already_initialized");
  expect(() =>
    a.apply({
      ...seed,
      action: { kind: "import", mesas: [{ id: "x", name: "changed", ids: [] }] },
    }),
  ).toThrow("request_conflict");
  expect(a.read()).toEqual(first);
  db.close();
});

// A client changes membership one tile at a time; it can never set a Mesa's members wholesale,
// which would drop a tile another device just added.
test("a command that sets members is refused by the contract", () => {
  const db = openDb(":memory:");
  const store = new WorkspaceStore(db);
  store.apply({
    requestId: crypto.randomUUID(),
    expectedRevision: 0,
    action: { kind: "import", mesas: [{ id: "one", name: "Mesa 1", ids: ["t1"] }] },
  });
  const edit = {
    requestId: crypto.randomUUID(),
    expectedRevision: 1,
    action: { kind: "edit", edits: [{ kind: "members", id: "one", ids: [] }] },
  };
  expect(() => store.apply(edit as unknown as WorkspaceCommand)).toThrow(ZodError);
  expect(store.read().mesas[0]?.ids).toEqual(["t1"]);
  db.close();
});

describe("intents", () => {
  const seeded = (mesas: SharedMesa[]) => {
    const db = openDb(":memory:");
    const store = new WorkspaceStore(db);
    store.apply({
      requestId: crypto.randomUUID(),
      expectedRevision: 0,
      action: { kind: "import", mesas },
    });
    return { db, store };
  };
  const send = (store: WorkspaceStore, intent: WorkspaceIntent, requestId = crypto.randomUUID()) =>
    store.apply({ requestId, action: { kind: "intent", intent } });
  const start: SharedMesa[] = [
    { id: "a", name: "A", ids: ["t1"] },
    { id: "b", name: "B", ids: ["t2"] },
  ];
  const membersAfter = (intents: WorkspaceIntent[]) => {
    const { db, store } = seeded(start);
    for (const intent of intents) send(store, intent);
    const mesas = store.read().mesas.map((m) => ({ ...m, ids: [...m.ids].sort() }));
    db.close();
    return mesas;
  };

  // AC2: two clients act from the same state on different terminals or Mesas; the server keeps
  // both, whatever reaches it first, and never refuses one for the other's revision.
  test.each<[string, WorkspaceIntent, WorkspaceIntent]>([
    [
      "two adds to one Mesa",
      { kind: "add", mesa: "a", tile: "t3" },
      { kind: "add", mesa: "a", tile: "t4" },
    ],
    [
      "add beside a rename",
      { kind: "add", mesa: "a", tile: "t3" },
      { kind: "rename", mesa: "a", name: "Bugs" },
    ],
    [
      "add beside closing another Mesa",
      { kind: "add", mesa: "a", tile: "t3" },
      { kind: "close", mesa: "b" },
    ],
    [
      "move beside a remove",
      { kind: "move", mesa: "b", tile: "t1" },
      { kind: "remove", mesa: "b", tile: "t2" },
    ],
    [
      "a new Mesa beside an add",
      { kind: "create", mesa: "c", name: "C", tile: "t2" },
      { kind: "add", mesa: "a", tile: "t3" },
    ],
  ])("%s: either order, same Mesas", (_, one, two) => {
    expect(membersAfter([one, two])).toEqual(membersAfter([two, one]));
  });

  // AC3 (P1): the first to arrive wins; the second is refused, with the state it met.
  test("a terminal added to two Mesas stays in the first; the second learns where it is", () => {
    const { db, store } = seeded(start);
    send(store, { kind: "add", mesa: "a", tile: "t9" });
    let refused: unknown;
    try {
      send(store, { kind: "add", mesa: "b", tile: "t9" });
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(WorkspaceConflict);
    expect((refused as WorkspaceConflict).message).toBe("terminal_elsewhere");
    expect((refused as WorkspaceConflict).current?.mesas.find((m) => m.id === "a")?.ids).toContain(
      "t9",
    );
    // Moving it is what takes it over.
    send(store, { kind: "move", mesa: "b", tile: "t9" });
    expect(store.read().mesas.map((m) => m.ids)).toEqual([["t1"], ["t2", "t9"]]);
    db.close();
  });

  test("two adds for the last free place: the second is refused as full", () => {
    const { db, store } = seeded([{ id: "a", name: "A", ids: ["1", "2", "3", "4", "5"] }]);
    send(store, { kind: "add", mesa: "a", tile: "6" });
    expect(() => send(store, { kind: "add", mesa: "a", tile: "7" })).toThrow("mesa_full");
    expect(store.read().mesas[0]?.ids).toHaveLength(6);
    db.close();
  });

  test("a repeated intent changes nothing and keeps the revision; a retried id answers the same", () => {
    const { db, store } = seeded(start);
    const id = crypto.randomUUID();
    const first = send(store, { kind: "add", mesa: "a", tile: "t3" }, id);
    expect(send(store, { kind: "add", mesa: "a", tile: "t3" }, id)).toEqual(first);
    expect(send(store, { kind: "add", mesa: "a", tile: "t3" }).revision).toBe(first.revision);
    expect(send(store, { kind: "remove", mesa: "b", tile: "nope" }).revision).toBe(first.revision);
    expect(send(store, { kind: "close", mesa: "gone" }).revision).toBe(first.revision);
    db.close();
  });

  test("panels sit in several Mesas; a terminal in one", () => {
    const state = { mesas: start, blocks: [] };
    const one = applyIntent(state, { kind: "add", mesa: "b", tile: "git:repo%3Aapp" });
    const both = applyIntent(one, { kind: "add", mesa: "a", tile: "git:repo%3Aapp" });
    expect(both.mesas.map((m) => m.ids.includes("git:repo%3Aapp"))).toEqual([true, true]);
    expect(applyIntent(both, { kind: "add", mesa: "a", tile: "code:x" }).mesas[0]?.ids).toContain(
      "code:x",
    );
    expect(() => applyIntent(state, { kind: "add", mesa: "b", tile: "t1" })).toThrow(
      "terminal_elsewhere",
    );
  });

  test("closing the last Mesa leaves an empty «Mesa 1»; a missing Mesa refuses add, move, rename", () => {
    expect(
      applyIntent(
        { mesas: [{ id: "x", name: "X", ids: ["t"] }], blocks: [] },
        { kind: "close", mesa: "x" },
      ).mesas,
    ).toEqual([{ id: "mesa-1", name: "Mesa 1", ids: [] }]);
    for (const intent of [
      { kind: "add", mesa: "z", tile: "t" },
      { kind: "move", mesa: "z", tile: "t" },
      { kind: "rename", mesa: "z", name: "Z" },
    ] as WorkspaceIntent[])
      expect(() => applyIntent({ mesas: start, blocks: [] }, intent)).toThrow("mesa_missing");
  });

  test("an intent before the first import is refused; old stored Mesas still load", () => {
    const db = openDb(":memory:");
    const store = new WorkspaceStore(db);
    expect(() => send(store, { kind: "add", mesa: "a", tile: "t" })).toThrow("workspace_empty");
    // A body written by the edit-only server, read by this one.
    db.run("INSERT INTO workspace_state VALUES (1,4,?)", [JSON.stringify(start)]);
    expect(store.read()).toEqual({ revision: 4, mesas: start, blocks: [] });
    expect(send(store, { kind: "add", mesa: "b", tile: "t3" }).revision).toBe(5);
    db.close();
  });

  test("blocks: create with Mesas, assign, rename, move, remove; Mesas stay", () => {
    const { db, store } = seeded(start);
    const made = send(store, {
      kind: "block-create",
      block: "w",
      name: "Trabajo",
      color: "blue",
      mesas: ["a"],
    });
    expect(made.blocks).toEqual([{ id: "w", name: "Trabajo", color: "blue" }]);
    expect(made.mesas[0]?.block).toBe("w");
    send(store, { kind: "block-create", block: "p", name: "Personal", color: "rose" });
    send(store, { kind: "assign", mesa: "b", block: "p" });
    send(store, { kind: "block-update", block: "p", name: "Casa" });
    send(store, { kind: "block-move", block: "p", index: 0 });
    expect(store.read().blocks.map((b) => b.name)).toEqual(["Casa", "Trabajo"]);
    expect(() => send(store, { kind: "assign", mesa: "b", block: "nope" })).toThrow(
      "block_missing",
    );
    const after = send(store, { kind: "block-remove", block: "w" });
    expect(after.blocks.map((b) => b.id)).toEqual(["p"]);
    expect(after.mesas).toEqual([
      { id: "a", name: "A", ids: ["t1"] },
      { id: "b", name: "B", ids: ["t2"], block: "p" },
    ]);
    // Repeating an intent changes nothing.
    const again = send(store, { kind: "assign", mesa: "b", block: "p" });
    expect(again.revision).toBe(after.revision);
    expect(send(store, { kind: "assign", mesa: "b", block: null }).mesas[1]).toEqual({
      id: "b",
      name: "B",
      ids: ["t2"],
    });
    db.close();
  });

  test("a new Mesa lands in the block it was made from; a removed block only loses the grouping", () => {
    const state = { mesas: start, blocks: [{ id: "w", name: "W", color: "green" as const }] };
    const into = applyIntent(state, { kind: "create", mesa: "c", name: "C", block: "w" });
    expect(into.mesas[2]).toEqual({ id: "c", name: "C", ids: [], block: "w" });
    const gone = applyIntent(state, { kind: "create", mesa: "c", name: "C", block: "x" });
    expect(gone.mesas[2]).toEqual({ id: "c", name: "C", ids: [] });
  });

  test("the body keeps blocks; an import without them starts with none", () => {
    const db = openDb(":memory:");
    const store = new WorkspaceStore(db);
    const first = store.apply({
      requestId: crypto.randomUUID(),
      expectedRevision: 0,
      action: { kind: "import", mesas: start },
    });
    expect(first.blocks).toEqual([]);
    send(store, { kind: "block-create", block: "w", name: "W", color: "amber", mesas: ["b"] });
    const body = db.query<{ body: string }, []>("SELECT body FROM workspace_state").get()?.body;
    expect(JSON.parse(body ?? "null")).toEqual({
      mesas: [start[0], { ...start[1], block: "w" }],
      blocks: [{ id: "w", name: "W", color: "amber" }],
    });
    // An import naming a block it does not carry is refused, never stored half.
    const other = openDb(":memory:");
    expect(() =>
      new WorkspaceStore(other).apply({
        requestId: crypto.randomUUID(),
        expectedRevision: 0,
        action: { kind: "import", mesas: [{ id: "a", name: "A", ids: [], block: "ghost" }] },
      }),
    ).toThrow("block_missing");
    db.close();
    other.close();
  });
});
