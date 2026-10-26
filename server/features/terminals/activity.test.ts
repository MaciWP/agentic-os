import { afterAll, describe, expect, test } from "bun:test";
import { ConfigSchema } from "../../config.ts";
import { openDb } from "../../db.ts";
import { Activity, type Clock, DWELL_MS, IDLE_BYTES, MUTE_MS, TICK_MS } from "./activity.ts";
import { cleanEnv } from "./env.ts";
import { TerminalManager } from "./pty.ts";

// A clock the test moves by hand; `every` runs only when the test advances past it.
function fakeClock(start = Date.parse("2026-10-02T10:00:00Z")) {
  let now = start;
  const timers = new Set<{ ms: number; next: number; run: () => void }>();
  const clock: Clock = {
    now: () => now,
    every(ms, run) {
      const t = { ms, next: now + ms, run };
      timers.add(t);
      return () => timers.delete(t);
    },
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter((t) => t.next <= end).sort((a, b) => a.next - b.next)[0];
      if (!due) break;
      now = due.next;
      due.next += due.ms;
      due.run();
    }
    now = end;
  };
  return { clock, advance, timers: () => timers.size };
}

function tracker(threshold: number | null) {
  const c = fakeClock();
  let flips = 0;
  const a = new Activity(threshold, () => flips++, c.clock);
  return { a, ...c, flips: () => flips };
}

describe("terminal activity", () => {
  test("output makes a shell busy at the next tick, and steady output never flips it again", () => {
    const t = tracker(IDLE_BYTES.shell);
    t.a.output(12);
    expect(t.a.state).toBe("idle");
    t.advance(TICK_MS);
    expect(t.a.state).toBe("busy");
    expect(t.flips()).toBe(1);
    for (let i = 0; i < 1000; i++) {
      t.a.output(40);
      if (i % 100 === 0) t.advance(TICK_MS);
    }
    expect(t.flips()).toBe(1);
    expect(t.timers()).toBe(1);
  });

  test("a busy terminal turns idle once its window is quiet, and the ticker stops", () => {
    const t = tracker(IDLE_BYTES.shell);
    t.a.output(5);
    t.advance(TICK_MS);
    expect(t.a.state).toBe("busy");
    t.advance(4 * TICK_MS);
    expect(t.a.state).toBe("busy");
    t.advance(2 * TICK_MS);
    expect(t.a.state).toBe("idle");
    expect(t.flips()).toBe(2);
    expect(t.timers()).toBe(0);
  });

  test("each state holds at least DWELL_MS: a burst right after going idle waits", () => {
    const t = tracker(IDLE_BYTES.shell);
    t.a.output(5);
    t.advance(TICK_MS);
    t.advance(6 * TICK_MS);
    expect(t.a.state).toBe("idle");
    const idleAt = Date.parse("2026-10-02T10:00:00Z") + 6 * TICK_MS;
    t.a.output(5);
    t.advance(TICK_MS);
    expect(t.a.state).toBe("idle");
    t.a.output(5);
    t.advance(DWELL_MS - TICK_MS);
    expect(t.a.state).toBe("busy");
    expect(t.clock.now() - idleAt).toBeGreaterThanOrEqual(DWELL_MS);
    expect(t.flips()).toBe(3);
  });

  test("claude's status line redraw stays idle; its work goes over the threshold", () => {
    const t = tracker(IDLE_BYTES.claude);
    t.a.output(78);
    t.advance(10 * TICK_MS);
    t.a.output(43);
    t.advance(10 * TICK_MS);
    expect(t.flips()).toBe(0);
    expect(t.timers()).toBe(0);
    for (let i = 0; i < 20; i++) t.a.output(80);
    t.advance(TICK_MS);
    expect(t.a.state).toBe("busy");
  });

  test("a harness whose output cannot tell is never tracked", () => {
    const t = tracker(IDLE_BYTES.grok);
    t.a.output(50_000);
    t.advance(10 * TICK_MS);
    expect(t.a.tracked).toBe(false);
    expect(t.a.lastOutputAt).toBeNull();
    expect(t.timers()).toBe(0);
    expect(t.flips()).toBe(0);
  });

  test("the redraw after a resize or typed keys is not counted", () => {
    const t = tracker(IDLE_BYTES.claude);
    t.a.mute();
    t.a.output(8000);
    t.advance(MUTE_MS - 1);
    t.a.output(8000);
    t.advance(10 * TICK_MS);
    expect(t.a.state).toBe("idle");
    expect(t.a.lastOutputAt).toBeNull();
    expect(t.flips()).toBe(0);
    t.a.output(8000);
    t.advance(TICK_MS);
    expect(t.a.state).toBe("busy");
  });

  test("an ended terminal is idle and leaves no ticker", () => {
    const t = tracker(IDLE_BYTES.shell);
    t.a.output(5);
    t.advance(TICK_MS);
    t.a.end();
    expect(t.a.state).toBe("idle");
    expect(t.timers()).toBe(0);
  });
});

describe("terminal manager activity", () => {
  const c = fakeClock();
  const config = ConfigSchema.parse({ terminals: { shell: "/bin/sh" } });
  const manager = new TerminalManager(
    config,
    openDb(":memory:"),
    () => Promise.resolve(cleanEnv({ PATH: "/usr/bin:/bin" }, {})),
    c.clock,
  );
  afterAll(() => manager.stopAll(200));

  test("the list shows activity, the last output and the pid, with one change per flip", async () => {
    const t = await manager.create({ harness: "shell", location: "app" });
    expect(t).toMatchObject({ activity: "idle", lastOutputAt: null });
    expect(t.pid).toBeGreaterThan(0);
    let changes = 0;
    const off = manager.subscribe(() => changes++);
    // The shell's prompt is its output; typed keys would be muted on a clock that stands still.
    await manager.waitFor(t.id, { quietMs: 300, timeoutMs: 5000 });
    expect(changes).toBe(0);
    c.advance(TICK_MS);
    expect(manager.get(t.id)).toMatchObject({
      activity: "busy",
      lastOutputAt: new Date(c.clock.now() - TICK_MS).toISOString(),
    });
    expect(changes).toBe(1);
    c.advance(10 * TICK_MS);
    expect(manager.get(t.id)?.activity).toBe("idle");
    expect(changes).toBe(2);

    // Keys typed in a window echo back at once: muted, so the terminal stays idle.
    const client = { send() {}, close() {}, isOpen: () => true, bufferedAmount: () => 0 };
    manager.attach(t.id, client);
    await manager.read(t.id, 1);
    // Past the attach's own mute and the idle state's dwell, so only the typing's mute can
    // hold the echo back.
    c.advance(DWELL_MS);
    // The attach is a change of its own; from here only a flip would add one.
    const attached = changes;
    const before = (await manager.read(t.id, 1))?.seq ?? 0;
    manager.input(t.id, client, "echo typed\n");
    await manager.waitFor(t.id, { after: before, quietMs: 300, timeoutMs: 5000 });
    expect((await manager.read(t.id, 5))?.text).toContain("typed");
    c.advance(10 * TICK_MS);
    expect(manager.get(t.id)?.activity).toBe("idle");
    expect(changes).toBe(attached);
    off();
  });
});
