import { describe, expect, test } from "bun:test";
import type { TerminalInfo, Terminals } from "../terminals/contract.ts";
import { KeepAwake, type Spawn } from "./keep-awake.ts";

function fakeSpawn() {
  const spawned: string[][] = [];
  let killed = 0;
  const spawn: Spawn = (argv) => {
    spawned.push(argv);
    return { kill: () => killed++ };
  };
  return { spawn, spawned, killed: () => killed };
}

const at = () => new Date("2026-10-06T14:00:00Z");

describe("keep awake", () => {
  test("the first running terminal starts one caffeinate tied to the server; the last stop ends it", () => {
    const f = fakeSpawn();
    const awake = new KeepAwake({ spawn: f.spawn, pid: 4242, now: at });
    expect(awake.state()).toEqual({ held: false, since: null, screen: null });
    awake.sync(true);
    awake.sync(true);
    expect(f.spawned).toEqual([["/usr/bin/caffeinate", "-i", "-s", "-w", "4242"]]);
    expect(awake.state()).toEqual({
      held: true,
      since: "2026-10-06T14:00:00.000Z",
      screen: null,
    });
    awake.sync(false);
    awake.sync(false);
    expect(f.killed()).toBe(1);
    expect(awake.state()).toEqual({ held: false, since: null, screen: null });
    awake.sync(true);
    expect(f.spawned).toHaveLength(2);
  });

  test("it follows the terminals list, keeps its state when a read fails, and stops on request", async () => {
    const f = fakeSpawn();
    const awake = new KeepAwake({ spawn: f.spawn, pid: 1, now: at });
    let list: Pick<TerminalInfo, "state">[] = [{ state: "running" }];
    let fail = false;
    let listener = () => {};
    let unsubscribed = false;
    const terminals = {
      list: async () => {
        if (fail) throw new Error("host gone");
        return list;
      },
      subscribe: (l: () => void) => {
        listener = l;
        return () => {
          unsubscribed = true;
        };
      },
    } as unknown as Terminals;
    const settle = () => new Promise((r) => setTimeout(r, 5));

    const stop = awake.follow(terminals);
    await settle();
    expect(awake.state().held).toBe(true);

    const errors: string[] = [];
    const original = console.error;
    console.error = (msg: string) => errors.push(msg.replace(/^\S+ (INFO|WARN|ERROR) /, ""));
    fail = true;
    listener();
    await settle();
    console.error = original;
    expect(awake.state().held).toBe(true);
    expect(errors).toEqual(["keep awake: host gone"]);

    fail = false;
    list = [{ state: "exited" }];
    listener();
    listener();
    await settle();
    expect(awake.state().held).toBe(false);
    expect(f.spawned).toHaveLength(1);

    stop();
    expect(unsubscribed).toBe(true);
  });

  test("the screen is held for a time, renewed by a new hold, and freed when it ends or on request", () => {
    const f = fakeSpawn();
    const timers: { ms: number; fn: () => void; cancelled: boolean }[] = [];
    const timer = (fn: () => void, ms: number) => {
      const t = { ms, fn, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    };
    const awake = new KeepAwake({ spawn: f.spawn, pid: 7, now: at, timer });
    awake.hold(60);
    expect(f.spawned).toEqual([["/usr/bin/caffeinate", "-d", "-i", "-s", "-w", "7"]]);
    expect(awake.state().screen).toEqual({ until: "2026-10-06T15:00:00.000Z", auto: false });
    expect(timers[0]?.ms).toBe(3_600_000);

    // A new hold replaces the time, not the process.
    awake.hold(null);
    expect(timers[0]?.cancelled).toBe(true);
    expect(f.spawned).toHaveLength(1);
    expect(awake.state().screen).toEqual({ until: null, auto: false });
    awake.release();
    expect(f.killed()).toBe(1);
    expect(awake.state().screen).toBeNull();

    awake.hold(120);
    timers[1]?.fn();
    expect(f.killed()).toBe(2);
    expect(awake.state().screen).toBeNull();
    // The system hold is a separate one.
    expect(awake.state().held).toBe(false);
  });

  test("with the option, the screen stays on while an agent works, and a manual hold outlasts it", () => {
    const f = fakeSpawn();
    const off = new KeepAwake({ spawn: f.spawn, pid: 7, now: at });
    off.sync(true, true);
    expect(f.spawned).toEqual([["/usr/bin/caffeinate", "-i", "-s", "-w", "7"]]);

    const g = fakeSpawn();
    const awake = new KeepAwake({ spawn: g.spawn, pid: 7, now: at, screenWhileAgentsWork: true });
    awake.sync(true, true);
    expect(g.spawned).toContainEqual(["/usr/bin/caffeinate", "-d", "-i", "-s", "-w", "7"]);
    expect(awake.state().screen).toEqual({ until: null, auto: true });
    awake.hold(null);
    awake.sync(true, false);
    expect(awake.state().screen).toEqual({ until: null, auto: false });
    awake.release();
    expect(awake.state().screen).toBeNull();
    expect(g.killed()).toBe(1);
  });
});

test("remote availability holds AC sleep only, and disposal cannot resurrect it", async () => {
  const f = fakeSpawn();
  const awake = new KeepAwake({ spawn: f.spawn, pid: 4242 });
  awake.remote(true);
  awake.remote(true);
  expect(f.spawned).toEqual([["/usr/bin/caffeinate", "-s", "-w", "4242"]]);
  expect(awake.state()).toMatchObject({ held: true, screen: null, remote: true });
  const pending = Promise.withResolvers<TerminalInfo[]>();
  const off = awake.follow({
    list: () => pending.promise,
    subscribe: () => () => {},
  } as unknown as Terminals);
  off();
  awake.dispose();
  pending.resolve([{ state: "running" } as TerminalInfo]);
  await Bun.sleep(5);
  expect(f.spawned).toHaveLength(1);
  expect(f.killed()).toBe(1);
});

test("a supervisor that holds remote availability leaves the server nothing to spawn", () => {
  const f = fakeSpawn();
  const awake = new KeepAwake({ spawn: f.spawn, pid: 4242, remoteHeld: true });
  awake.remote(true);
  expect(f.spawned).toEqual([]);
  expect(awake.state()).toMatchObject({ held: true, remote: true });
  awake.remote(false);
  expect(awake.state()).toMatchObject({ held: false });
  expect(awake.state().remote).toBeUndefined();
});
