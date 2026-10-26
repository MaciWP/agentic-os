import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logsText, tailLines } from "./logs.ts";

const dir = mkdtempSync(join(tmpdir(), "aos-logs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("the last lines of a log, CRLF or not, and null when it is missing", async () => {
  const file = join(dir, "a.log");
  writeFileSync(file, "one\r\ntwo\r\nthree\r\n");
  expect(await tailLines(file, 2)).toEqual(["two", "three"]);
  expect(await tailLines(file, 10)).toEqual(["one", "two", "three"]);
  expect(await tailLines(join(dir, "none.log"), 5)).toBeNull();
});

test("a log larger than the window drops the half line it cut", async () => {
  const file = join(dir, "big.log");
  const line = "x".repeat(99);
  writeFileSync(file, `${Array.from({ length: 3000 }, () => line).join("\n")}\nlast\n`);
  const tail = await tailLines(file, 100_000);
  expect(tail?.at(-1)).toBe("last");
  expect(tail?.every((l) => l === line || l === "last")).toBe(true);
});

test("each log comes under its name", async () => {
  const file = join(dir, "server.log");
  writeFileSync(file, "ready\n");
  expect(await logsText([file, join(dir, "launcher.log")], 10)).toBe(
    "===== server.log\nready\n\n===== launcher.log\n(no existe)\n",
  );
});
