import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Every subprocess the server starts. A short one goes through `run()` (server/run.ts): a
// timeout, an output cap and a process-group kill. Only the processes below may spawn by hand,
// because they are meant to outlive a call. `scripts/` is out: those are command-line tools a
// person or the launcher runs, not the server.

// Long-lived processes, by file, with how many spawns each file holds and why.
const LONG_LIVED: Record<string, { spawns: number; reason: string }> = {
  "server/host/launch.ts": { spawns: 1, reason: "the PTY host, which outlives the server" },
  "server/features/terminals/pty.ts": { spawns: 1, reason: "a terminal's process, for its life" },
  "server/features/system/keep-awake.ts": {
    spawns: 1,
    reason: "caffeinate, held while agents work",
  },
  "server/features/images/clipboard-watch.ts": {
    spawns: 1,
    reason: "the clipboard watcher, running until it is turned off",
  },
  "server/features/images/hotkey.ts": {
    spawns: 1,
    reason: "AgenticCapture holding ⌃⌘4, for the server's life",
  },
  "server/features/voice/engine.ts": {
    spawns: 1,
    reason: "the speech worker, kept loaded between dictations",
  },
  "server/features/ai/engine.ts": {
    spawns: 1,
    reason: "llama-server, kept loaded until its idle minutes pass",
  },
  "server/features/coordination/adapters.ts": {
    spawns: 1,
    reason: "a consultation's worker, for minutes, leased by a pipe and killed by group",
  },
  "server/features/coordination/worker.ts": {
    spawns: 1,
    reason: "the model run inside a consultation's worker",
  },
  "server/features/envs/jobs.ts": {
    spawns: 1,
    reason: "an env command (create, start), minutes long with streamed output",
  },
  "server/features/terminals/routes.ts": {
    spawns: 1,
    reason: "opens the user's editor, which stays open after the request",
  },
  "server/ps-session.ts": {
    spawns: 1,
    reason: "Windows PowerShell kept open between CIM queries, until idle",
  },
};

// Short spawns not yet moved onto run(), with the front that owns the file. The list only
// shrinks: an entry whose spawn is gone fails until it is removed.
const PENDING: Record<string, { spawns: number; owner: string }> = {};

const ROOT = join(import.meta.dir, "..");
const SPAWN = /\bBun\.spawn(?:Sync)?\s*\(|\bBun\.\$|from\s+["'](?:node:)?child_process["']/g;

function spawnCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of new Bun.Glob("server/**/*.{ts,tsx}").scanSync(ROOT)) {
    if (/\.test\.tsx?$/.test(file) || file === "server/run.ts") continue;
    const n = readFileSync(join(ROOT, file), "utf8").match(SPAWN)?.length ?? 0;
    if (n > 0) counts.set(file, n);
  }
  return counts;
}

test("every short subprocess in the server goes through run()", () => {
  const counts = spawnCounts();
  const files = new Set([...counts.keys(), ...Object.keys(LONG_LIVED), ...Object.keys(PENDING)]);
  const wrong = [...files]
    .map((file) => {
      const expected = (LONG_LIVED[file]?.spawns ?? 0) + (PENDING[file]?.spawns ?? 0);
      return { file, found: counts.get(file) ?? 0, expected };
    })
    .filter((f) => f.found !== f.expected);
  // A file over its count spawns by hand: use run(), or list it above with the reason.
  // A file under its count fixed a PENDING entry or dropped a long-lived one: update the lists.
  expect(wrong).toEqual([]);
});

test("the pattern sees every way to start a process", () => {
  const seen = (code: string) => code.match(SPAWN)?.length ?? 0;
  expect(seen('Bun.spawn(["ls"])')).toBe(1);
  expect(seen("Bun.spawnSync(argv)")).toBe(1);
  expect(seen("await Bun.$`ls`")).toBe(1);
  expect(seen('import { spawn } from "node:child_process";')).toBe(1);
  // A template that ends a RegExp with `$` is not a shell call.
  expect(seen("new RegExp(`^id.png$`)")).toBe(0);
});
