import { describe, expect, test } from "bun:test";
import {
  isAsking,
  newlyWaiting,
  settled,
  snapshot,
  stillWaiting,
  unseenAsks,
} from "./attention.tsx";
import { terminal } from "./test-fixtures.ts";

const working = { sessionId: "s", state: "working" as const };
const needsYou = { sessionId: "s", state: "needs_you" as const };

describe("attention", () => {
  test("an agent whose turn ends, and any terminal that ends, start to wait", () => {
    const before = snapshot([
      terminal({ id: "a", agent: working }),
      terminal({ id: "b", harness: "shell" }),
      terminal({ id: "c", agent: working }),
    ]);
    const now = [
      terminal({ id: "a", agent: needsYou }),
      terminal({ id: "b", harness: "shell", state: "exited", exitCode: 0 }),
      terminal({ id: "c", agent: working }),
    ];
    expect(newlyWaiting(before, now)).toEqual(["a", "b"]);
  });

  test("nothing counts the first time a terminal is seen, so a page load is silent", () => {
    expect(newlyWaiting(snapshot([]), [terminal({ id: "a", agent: needsYou })])).toEqual([]);
    expect(newlyWaiting(snapshot([]), [terminal({ id: "b", state: "exited" })])).toEqual([]);
  });

  test("an agent already waiting, or one that has not worked yet, does not count again", () => {
    const before = snapshot([
      terminal({ id: "a", agent: needsYou }),
      terminal({ id: "b", agent: null }),
      terminal({ id: "c", state: "exited" }),
    ]);
    const now = [
      terminal({ id: "a", agent: needsYou }),
      terminal({ id: "b", agent: needsYou }),
      terminal({ id: "c", state: "exited" }),
    ];
    expect(newlyWaiting(before, now)).toEqual([]);
  });

  test("a terminal removed, or an agent working again, waits no more", () => {
    const waiting = new Set(["a", "b", "c"]);
    const now = [terminal({ id: "a", agent: working }), terminal({ id: "c", state: "exited" })];
    expect([...stillWaiting(waiting, now)]).toEqual(["c"]);
  });

  test("after a reload, what waited comes back once it is no longer lost, and only once", () => {
    const pending = new Set(["a", "b", "gone"]);
    const resuming = [terminal({ id: "a", state: "lost" }), terminal({ id: "b", state: "exited" })];
    expect(settled(pending, resuming).map((t) => t.id)).toEqual(["b"]);
    const resumed = [
      terminal({ id: "a", agent: needsYou }),
      terminal({ id: "b", state: "exited" }),
    ];
    expect(settled(pending, resumed).map((t) => t.id)).toEqual(["a"]);
    expect(settled(pending, resumed)).toEqual([]);
  });

  test("a question or a permission asked while no tab watched joins quietly, once", () => {
    const asks = { ...needsYou, asks: "question" as const };
    const now = [
      terminal({ id: "q", agent: asks }),
      terminal({ id: "p", agent: { ...needsYou, asks: "permission" as const } }),
      terminal({ id: "turn", agent: needsYou }),
      terminal({ id: "ended", state: "exited", agent: asks }),
    ];
    expect(now.filter(isAsking).map((t) => t.id)).toEqual(["q", "p"]);
    expect(unseenAsks(new Set(["p"]), now).map((t) => t.id)).toEqual(["q"]);
  });
});
