import { expect, test } from "bun:test";
import { openDb } from "../../db.ts";
import type { TerminalInfo } from "./contract.ts";
import { LaunchError } from "./harness.ts";
import { LaunchRequests } from "./launch-requests.ts";

test("repeated and concurrent launches reuse one durable result", async () => {
  const db = openDb(":memory:");
  const ledger = new LaunchRequests(db);
  const spec = { requestId: crypto.randomUUID(), harness: "shell" as const, location: "app" };
  let starts = 0;
  const info: TerminalInfo = {
    id: crypto.randomUUID(),
    state: "running",
    harness: "shell",
    location: "app",
    cwd: "/tmp",
    ticket: null,
    name: null,
    env: null,
    action: null,
    exitCode: null,
    signal: null,
    error: null,
    overflowed: false,
    attached: false,
    activity: null,
    lastOutputAt: null,
    pid: 123,
    startedAt: new Date().toISOString(),
    endedAt: null,
  };
  const start = async () => {
    starts++;
    await Bun.sleep(5);
    return info;
  };
  const result = await Promise.all([ledger.run(spec, start), ledger.run(spec, start)]);
  expect(result).toEqual([info, info]);
  expect(await new LaunchRequests(db).run(spec, start)).toEqual(info);
  expect(starts).toBe(1);
  await expect(ledger.run({ ...spec, location: "different" }, start)).rejects.toThrow(
    "request_conflict",
  );
  db.close();
});

test("a failed or interrupted claim never launches automatically again", async () => {
  const db = openDb(":memory:");
  const ledger = new LaunchRequests(db);
  const spec = { requestId: crypto.randomUUID(), harness: "shell" as const, location: "app" };
  let starts = 0;
  const fail = async (): Promise<TerminalInfo> => {
    starts++;
    throw new Error("lost response");
  };
  await expect(ledger.run(spec, fail)).rejects.toThrow("lost response");
  await expect(new LaunchRequests(db).run(spec, fail)).rejects.toThrow("launch_uncertain");
  expect(starts).toBe(1);
  expect(ledger.get(spec.requestId)).toMatchObject({ state: "uncertain", error: null });
  db.close();
});

test("a launch refused before anything started replays the refusal", async () => {
  const db = openDb(":memory:");
  const ledger = new LaunchRequests(db);
  const spec = { requestId: crypto.randomUUID(), harness: "shell" as const, location: "app" };
  let starts = 0;
  const refuse = async (): Promise<TerminalInfo> => {
    starts++;
    throw new LaunchError("at most 12 terminals");
  };
  await expect(ledger.run(spec, refuse)).rejects.toThrow("at most 12 terminals");
  const replay = new LaunchRequests(db).run(spec, refuse);
  await expect(replay).rejects.toBeInstanceOf(LaunchError);
  await expect(replay).rejects.toThrow("at most 12 terminals");
  expect(starts).toBe(1);
  expect(ledger.get(spec.requestId)).toMatchObject({
    state: "rejected",
    terminal: null,
    error: "at most 12 terminals",
  });
  await expect(ledger.run({ ...spec, location: "different" }, refuse)).rejects.toThrow(
    "request_conflict",
  );
  db.close();
});
