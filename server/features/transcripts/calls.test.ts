import { describe, expect, test } from "bun:test";
import { CALL_TIMING, CallWatcher, inCallOf } from "./calls.ts";

const S = 1000;
const T0 = Date.parse("2026-10-22T09:00:00Z");

function harness(timing = { startMs: 5 * S, stopMs: 60 * S }) {
  const state = {
    call: false,
    recs: [] as { id: string; createdAt: string; running: boolean }[],
  };
  let now = T0;
  const watcher = new CallWatcher(
    {
      inCall: async () => state.call,
      running: () => state.recs.find((r) => r.running) ?? null,
      recordedSince: (at) => state.recs.some((r) => Date.parse(r.createdAt) >= at),
      start: async () => {
        state.recs.push({
          id: `r${state.recs.length}`,
          createdAt: new Date(now).toISOString(),
          running: true,
        });
      },
      stop: (id) => {
        const rec = state.recs.find((r) => r.id === id);
        if (rec) rec.running = false;
      },
    },
    timing,
  );
  // Ticks every 5 s for `seconds`.
  const run = async (seconds: number) => {
    for (let t = 0; t < seconds; t += 5) {
      await watcher.tick(now);
      now += 5 * S;
    }
  };
  const startByHand = () =>
    state.recs.push({ id: "hand", createdAt: new Date(now).toISOString(), running: true });
  return { state, run, startByHand };
}

describe("CallWatcher", () => {
  test("two meetings back to back, 30 s apart, are two recordings", async () => {
    const h = harness(CALL_TIMING);
    h.state.call = true;
    await h.run(600);
    h.state.call = false;
    await h.run(30);
    h.state.call = true;
    await h.run(600);
    expect(h.state.recs.map((r) => r.running)).toEqual([false, true]);
  });

  test("a call records once it has lasted 5 s, and stops 60 s after the hang-up", async () => {
    const h = harness();
    h.state.call = true;
    await h.run(5);
    expect(h.state.recs).toHaveLength(0);
    await h.run(30);
    expect(h.state.recs).toHaveLength(1);
    h.state.call = false;
    await h.run(55);
    expect(h.state.recs[0]?.running).toBe(true);
    await h.run(10);
    expect(h.state.recs[0]?.running).toBe(false);
  });

  test("a drop shorter than the stop wait keeps one recording", async () => {
    const h = harness();
    h.state.call = true;
    await h.run(20);
    h.state.call = false;
    await h.run(40);
    h.state.call = true;
    await h.run(20);
    expect(h.state.recs).toEqual([expect.objectContaining({ running: true })]);
  });

  test("a recording stopped by hand during the call is not started again", async () => {
    const h = harness();
    h.state.call = true;
    await h.run(20);
    (h.state.recs[0] as { running: boolean }).running = false;
    await h.run(60);
    expect(h.state.recs).toHaveLength(1);
  });

  test("a recording started by hand with no call stays when nothing hangs up", async () => {
    const h = harness();
    h.startByHand();
    await h.run(120);
    expect(h.state.recs[0]?.running).toBe(true);
  });

  test("a hand recording made after a call ended survives that call's stop", async () => {
    const h = harness();
    h.state.call = true;
    await h.run(20);
    (h.state.recs[0] as { running: boolean }).running = false;
    h.state.call = false;
    await h.run(10);
    h.startByHand();
    await h.run(120);
    expect(h.state.recs.find((r) => r.id === "hand")?.running).toBe(true);
  });
});

describe("inCallOf", () => {
  const data = (bundleId: string, isRunningInput: boolean) => ({
    processes: [
      { bundleId: "local.agentic-os.audio", isRunningInput: true },
      { bundleId, isRunningInput, pid: 1 },
    ],
  });
  test("only the meeting app's input counts", () => {
    expect(inCallOf(data("com.microsoft.teams2.modulehost", true), "com.microsoft.teams2")).toBe(
      true,
    );
    expect(inCallOf(data("com.microsoft.teams2.modulehost", false), "com.microsoft.teams2")).toBe(
      false,
    );
  });
  test("an answer of another shape is an error, never «no call»", () => {
    expect(() => inCallOf({ processes: "none" }, "com.microsoft.teams2")).toThrow();
  });
});
