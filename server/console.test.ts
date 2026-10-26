import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

// Files that still write their own lines, kept until their owner moves them onto log.ts. The
// test fails on a new one, and on a listed one that is clean, so the list only shrinks.
const PENDING: Record<string, { owner: string }> = {};

// A direct console call. Reading stdin with `for await (… of console)` is no log line.
const CONSOLE = /\bconsole\.\w+\s*\(/;

test("the server and the PTY host log only through log.ts", () => {
  const writers = [...new Bun.Glob("server/**/*.{ts,tsx}").scanSync(root)]
    .filter((f) => !/\.test\.tsx?$/.test(f) && f !== "server/log.ts")
    .filter((f) => CONSOLE.test(readFileSync(join(root, f), "utf8")))
    .sort();
  expect(writers).toEqual(Object.keys(PENDING).sort());
});

test("the pattern sees a console call and not a stdin read", () => {
  expect(CONSOLE.test('console.error("x")')).toBe(true);
  expect(CONSOLE.test("console.log (x)")).toBe(true);
  expect(CONSOLE.test("for await (const line of console) {")).toBe(false);
});
