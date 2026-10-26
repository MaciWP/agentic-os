import { expect, test } from "bun:test";
import { type Exit, supervise } from "./supervise.ts";

// Runs the policy against scripted server exits, recording each wait.
// `lockFree` answers each probe of a busy lock in turn; past the list the lock is free.
async function run(exits: Exit[], stopAfter = Number.POSITIVE_INFINITY, lockFree: boolean[] = []) {
  const slept: number[] = [];
  let starts = 0;
  let probes = 0;
  const code = await supervise({
    start: async () => exits[starts++] as Exit,
    sleep: async (ms) => {
      slept.push(ms);
    },
    log: () => {},
    stopped: () => starts >= stopAfter,
    lockFree: () => lockFree[probes++] ?? true,
  });
  return { code, slept, starts };
}

test("a clean exit (a 4317 restart) starts the current code at once, until a stop", async () => {
  const r = await run(
    [
      { code: 0, ms: 5_000 },
      { code: 0, ms: 9_000 },
    ],
    2,
  );
  expect(r).toEqual({ code: 0, slept: [], starts: 2 });
});

test("a busy lock means another server runs: wait for it to go, then start again", async () => {
  const r = await run(
    [
      { code: 3, ms: 200 },
      { code: 0, ms: 5_000 },
    ],
    2,
    [false, false],
  );
  expect(r).toEqual({ code: 0, slept: [5_000, 5_000], starts: 2 });
});

test("a stop asked for while the lock is busy ends the wait", async () => {
  let waits = 0;
  let starts = 0;
  const code = await supervise({
    start: async () => {
      starts++;
      return { code: 3, ms: 200 };
    },
    sleep: async () => {
      waits++;
    },
    log: () => {},
    stopped: () => waits >= 2,
    lockFree: () => false,
  });
  expect({ code, waits, starts }).toEqual({ code: 0, waits: 2, starts: 1 });
});

test("a crash, or a death by signal, is restarted after a growing wait", async () => {
  const r = await run(
    [
      { code: 1, ms: 500 },
      { code: null, ms: 500 },
      { code: 1, ms: 9_000 },
    ],
    3,
  );
  expect(r).toEqual({ code: 0, slept: [1_000, 2_000], starts: 3 });
});

test("a server that ran a while starts the wait over", async () => {
  const r = await run(
    [
      { code: 1, ms: 70_000 },
      { code: 1, ms: 500 },
      { code: 1, ms: 70_000 },
      { code: 1, ms: 1 },
    ],
    4,
  );
  expect(r.slept).toEqual([1_000, 2_000, 1_000]);
});

test("a crash loop never gives up: the wait grows to a minute and stays there", async () => {
  const crash = { code: 1, ms: 300 };
  const r = await run([...Array(10).fill(crash)], 10);
  expect(r).toEqual({
    code: 0,
    slept: [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000],
    starts: 10,
  });
});

test("a stop asked for during a crash is honoured without another start", async () => {
  expect(await run([{ code: 1, ms: 300 }], 1)).toEqual({ code: 0, slept: [], starts: 1 });
});
