import { describe, expect, test } from "bun:test";
import { DOWN_MS, StreamHealth } from "./events.ts";

// A timer the test fires by hand.
function manualTimer() {
  const due: { fn: () => void; ms: number; live: boolean }[] = [];
  const timer = (fn: () => void, ms: number) => {
    const t = { fn, ms, live: true };
    due.push(t);
    return () => {
      t.live = false;
    };
  };
  const fire = () => {
    for (const t of due.splice(0)) if (t.live) t.fn();
  };
  return { timer, fire, due };
}

describe("StreamHealth", () => {
  test("down only once an error has lasted DOWN_MS with no open; up again on the next open", () => {
    const seen: boolean[] = [];
    const clock = manualTimer();
    const health = new StreamHealth((down) => seen.push(down), clock.timer);
    health.failed();
    health.failed();
    // One pending timer for repeated errors, of DOWN_MS.
    expect(clock.due.map((t) => t.ms)).toEqual([DOWN_MS]);
    expect(seen).toEqual([]);
    clock.fire();
    expect(seen).toEqual([true]);
    health.opened();
    expect(seen).toEqual([true, false]);
  });

  test("a blip that reopens before DOWN_MS never shows", () => {
    const seen: boolean[] = [];
    const clock = manualTimer();
    const health = new StreamHealth((down) => seen.push(down), clock.timer);
    health.failed();
    health.opened();
    clock.fire();
    expect(seen).toEqual([false]);
  });
});
