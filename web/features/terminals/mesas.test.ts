import { afterEach, describe, expect, test } from "bun:test";
import { memoryStorage } from "../../test-storage.ts";
import {
  activeMesa,
  autoName,
  closeMesa,
  createMesa,
  createMesaStore,
  isAutoName,
  mesaTopic,
  moveTerminal,
  openInMesa,
  renameMesa,
  reorderMesa,
  resolveMesaSearch,
  splitName,
  ticketBadge,
} from "./mesas.ts";
import { mesaPhase } from "./panel.tsx";
import { terminal } from "./test-fixtures.ts";
import { mergeWorkspace } from "./workspace-sync.tsx";

// A fresh in-memory local storage behind the Mesas, for one test.
const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});
const storage = (entries: Record<string, string> | null = {}) => {
  const disk = memoryStorage("local", entries);
  restores.push(disk.restore);
  return disk.data;
};
const two = () => {
  storage();
  const first = createMesaStore().getSnapshot().workspace;
  return createMesa(openInMesa(first, "a"), "second");
};

describe("Mesas", () => {
  test("imports the previous grid and split once, without deleting them", () => {
    const layout = { dir: "row", kids: [{ id: "a" }, { id: "b" }], sizes: [0.3, 0.7] };
    const disk = storage({ "aos.grid": "a,b", "aos.grid.layout": JSON.stringify(layout) });
    const store = createMesaStore();
    expect(store.getSnapshot().workspace.mesas[0]).toMatchObject({
      name: "Mesa 1",
      ids: ["a", "b"],
      layout,
    });
    store.update((s) => createMesa(s, "second"));
    disk.set("aos.grid", "old");
    expect(createMesaStore().getSnapshot().workspace.mesas).toHaveLength(2);
    expect(disk.get("aos.grid.layout")).toBe(JSON.stringify(layout));
  });
  test("moving is exclusive and a full target changes neither Mesa", () => {
    const start = two();
    const moved = moveTerminal(start, "a", "second");
    expect(moved.mesas[0]?.ids).toEqual([]);
    expect(moved.mesas[1]?.ids).toEqual(["a"]);
    expect(moved.activeId).toBe("second");
    let full = start;
    for (const id of ["b", "c", "d", "e", "f", "g"]) full = openInMesa(full, id);
    expect(moveTerminal(full, "a", "second")).toEqual(full);
    expect(openInMesa(full, "a").activeId).toBe(activeMesa(start, "mesa-1").id);
  });
  test("closing releases terminals and closing the last Mesa leaves an empty one", () => {
    const start = two();
    const closed = closeMesa(start, activeMesa(start, "mesa-1").id);
    expect(closed.mesas).toHaveLength(1);
    expect(closed.mesas[0]?.ids).toEqual([]);
    expect(closeMesa(closed, "second").mesas[0]).toMatchObject({ name: "Mesa 1", ids: [] });
  });
  test("names, membership, maximization and layout survive another store", () => {
    storage();
    const store = createMesaStore();
    store.update(() => renameMesa(two(), "second", "  Revisión  "));
    expect(createMesaStore().getSnapshot().workspace).toEqual(store.getSnapshot().workspace);
    expect(store.getSnapshot().workspace.mesas[1]?.name).toBe("Revisión");
    expect(renameMesa(two(), "second", " ")).toEqual(two());
    expect(renameMesa(two(), "second", "x".repeat(41))).toEqual(two());
  });
  test("bad storage falls back and failed writes retain the change in memory", () => {
    const disk = storage({ "aos.mesas": "broken" });
    const store = createMesaStore();
    expect(store.getSnapshot().workspace.mesas).toHaveLength(1);
    disk.set = () => {
      throw new Error("quota");
    };
    store.update((s) => createMesa(s, "second"));
    expect(store.getSnapshot().workspace.mesas).toHaveLength(2);
    expect(store.getSnapshot().saved).toBe(false);
  });
  test("legacy links omit another Mesa's terminals and report their owner", () => {
    const start = two();
    const result = resolveMesaSearch(start, { ids: "a,b", max: "a" });
    expect(result.workspace.mesas[1]?.ids).toEqual(["b"]);
    expect(result.workspace.mesas[1]?.max).toBeUndefined();
    expect(result.omitted).toEqual(["Mesa 1"]);
    expect(resolveMesaSearch(start, { mesa: "missing" }).workspace.activeId).toBe("second");
  });
  test("a terminal link reaches its owner even when another tile was maximized", () => {
    let start = two();
    start = openInMesa(start, "b", activeMesa(start, "mesa-1").id);
    start = { ...start, mesas: start.mesas.map((m, i) => (i === 0 ? { ...m, max: "b" } : m)) };
    const result = resolveMesaSearch(start, { mesa: "second", t: "a" }).workspace;
    expect(result.activeId).toBe(activeMesa(start, "mesa-1").id);
    expect(result.mesas[0]?.max).toBe("a");
  });
  test("a launch can finish in its origin, or in the active Mesa after its origin closes", () => {
    const start = two();
    const origin = activeMesa(start, "mesa-1").id;
    expect(openInMesa(start, "new", origin).mesas[0]?.ids).toEqual(["a", "new"]);
    expect(openInMesa(closeMesa(start, origin), "new", origin).mesas[0]?.ids).toEqual(["new"]);
  });
  test("assigning a previewed terminal removes its temporary view from the other Mesa", () => {
    storage();
    let state = createMesaStore().getSnapshot().workspace;
    for (const id of ["a", "b", "c", "d", "e", "f", "preview"]) state = openInMesa(state, id);
    expect(state.mesas[0]?.max).toBe("preview");
    state = openInMesa(createMesa(state, "second"), "preview");
    expect(state.mesas[0]?.max).toBeUndefined();
    expect(state.mesas[1]?.ids).toEqual(["preview"]);
  });
  test("an emoji at the start of the name is the Mesa's icon and survives a rename", () => {
    expect(splitName("🐛 Bugs")).toEqual({ icon: "🐛", base: "Bugs" });
    expect(splitName("🛠️ Mesa 3")).toEqual({ icon: "🛠️", base: "Mesa 3" });
    expect(splitName("Bugs 🐛")).toEqual({ icon: null, base: "Bugs 🐛" });
    expect(splitName("A Bugs")).toEqual({ icon: null, base: "A Bugs" });
    const named = renameMesa(two(), "second", "Revisión", "🔍");
    expect(named.mesas[1]?.name).toBe("🔍 Revisión");
    expect(renameMesa(named, "second", "Backend").mesas[1]?.name).toBe("🔍 Backend");
    expect(renameMesa(named, "second", "Backend", null).mesas[1]?.name).toBe("Backend");
    // Not an emoji, two of them, or one joined with a ZWJ (a format character): refused.
    expect(renameMesa(two(), "second", "x", "a")).toEqual(two());
    expect(renameMesa(two(), "second", "x", "🐛🐛")).toEqual(two());
    expect(renameMesa(two(), "second", "x", "👩‍💻")).toEqual(two());
  });
  test("an empty name gives a chosen Mesa back a free Mesa N, so it names itself again", () => {
    const named = renameMesa(two(), "second", "Revisión", "🔍");
    const back = renameMesa(named, "second", "");
    expect(back.mesas[1]?.name).toBe("🔍 Mesa 2");
    expect(isAutoName("🔍 Mesa 2")).toBe(true);
    expect(isAutoName("Revisión")).toBe(false);
    expect(createMesa(back, "third").mesas[2]?.name).toBe("Mesa 3");
  });
  test("an unnamed Mesa shows its tickets, else a terminal's name or its agent's title", () => {
    const mesa = { name: "Mesa 1", ids: ["a", "b", "git:x"] };
    const a = terminal({
      id: "a",
      agent: { sessionId: null, state: "working", title: "Fix login" },
    });
    const b = terminal({ id: "b", name: "api" });
    expect(autoName(mesa, [a, b])).toBe("api");
    expect(autoName({ ...mesa, ids: ["a", "b"] }, [a])).toBe("Fix login");
    const tickets = [
      { ...a, ticket: "ABC-1033" },
      { ...b, ticket: "ABC-1200" },
    ];
    expect(autoName(mesa, tickets)).toBe("ABC-1033 +1");
    expect(autoName(mesa, [tickets[0] ?? a, b])).toBe("ABC-1033");
    expect(autoName({ ...mesa, name: "Backend" }, tickets)).toBeNull();
    expect(autoName({ ...mesa, ids: [] }, tickets)).toBeNull();
    expect(autoName(mesa, [terminal({ id: "a", harness: "shell" })])).toBeNull();
  });
  test("a Mesa's topic: its tickets as one badge, else its first free-text goal", () => {
    const goal = { kind: "goal" as const, id: 1, title: "Arreglar el login", closedAt: null };
    const a = terminal({ id: "a", ticket: "ABC-1" });
    const b = terminal({ id: "b", objective: goal });
    const mesa = { name: "Mesa 1", ids: ["a", "b"] };
    expect(mesaTopic(mesa, [a, b])).toMatchObject({
      tickets: ["ABC-1"],
      goal: "Arreglar el login",
    });
    expect(ticketBadge(["ABC-1", "ABC-2", "ABC-3"])).toBe("ABC-1 +2");
    expect(ticketBadge([])).toBeNull();
    // With no ticket, the goal names an auto Mesa before what its terminals call themselves.
    expect(
      autoName({ ...mesa, ids: ["b"] }, [terminal({ id: "b", objective: goal, name: "api" })]),
    ).toBe("Arreglar el login");
  });
  test("a Mesa's icon says it works first, then the most pressing wait", () => {
    const at = (state: "working" | "needs_you", asks?: "question") =>
      terminal({ agent: { sessionId: null, state, asks } });
    const ended = terminal({ state: "exited", exitCode: 0 });
    const failed = terminal({ state: "exited", exitCode: 2 });
    expect(mesaPhase([])).toBeNull();
    expect(mesaPhase([ended, at("working")])?.key).toBe("working");
    expect(mesaPhase([at("needs_you"), at("working")])?.key).toBe("working");
    expect(mesaPhase([failed, at("needs_you", "question"), at("working")])?.key).toBe("working");
    expect(mesaPhase([at("needs_you"), at("needs_you", "question"), failed])?.key).toBe("failed");
    expect(mesaPhase([at("needs_you"), at("needs_you", "question")])?.key).toBe("asks");
    expect(mesaPhase([ended, at("needs_you")])?.key).toBe("turn");
  });
  test("a tab moves to any place, and the shared workspace keeps this browser's order", () => {
    const three = createMesa(two(), "third");
    const order = (w: typeof three) => w.mesas.map((m) => m.id);
    expect(order(reorderMesa(three, "third", 0))).toEqual(["third", "mesa-1", "second"]);
    expect(order(reorderMesa(three, "mesa-1", 1))).toEqual(["second", "mesa-1", "third"]);
    expect(order(reorderMesa(three, "mesa-1", 9))).toEqual(["second", "third", "mesa-1"]);
    expect(reorderMesa(three, "mesa-1", -1)).toBe(three);
    expect(reorderMesa(three, "missing", 0)).toBe(three);
    const local = reorderMesa(three, "third", 0);
    const remote = {
      revision: 3,
      blocks: [],
      mesas: [
        { id: "mesa-1", name: "Mesa 1", ids: ["a"] },
        { id: "fourth", name: "Mesa 4", ids: [] },
        { id: "third", name: "Mesa 3", ids: [] },
        { id: "second", name: "Mesa 2", ids: [] },
      ],
    };
    expect(order(mergeWorkspace(local, remote))).toEqual(["third", "mesa-1", "second", "fourth"]);
  });
});
