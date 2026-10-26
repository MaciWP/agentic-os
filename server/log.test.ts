import { expect, test } from "bun:test";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log, makePrivate, rotate } from "./log.ts";

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, sink: { log: (l: string) => out.push(l), error: (l: string) => err.push(l) } };
};
const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /;

test("one timestamped line per call; info to stdout, warn and error to stderr", () => {
  const { out, err, sink } = capture();
  const voice = log("voice", sink);
  voice.info("5.0 s audio, 311 ms");
  voice.warn("slow");
  voice.error("failed");
  expect(out).toHaveLength(1);
  expect(out[0]).toMatch(STAMP);
  expect(out[0]?.replace(STAMP, "")).toBe("INFO voice: 5.0 s audio, 311 ms");
  expect(err.map((l) => l.replace(STAMP, ""))).toEqual(["WARN voice: slow", "ERROR voice: failed"]);
});

test("fields follow as key=value, quoted when they hold spaces; empty ones are left out", () => {
  const { out, sink } = capture();
  log("http", sink).info("POST /api/x 200", {
    ms: 12,
    id: "r-1",
    why: "two words",
    none: undefined,
  });
  expect(out[0]?.replace(STAMP, "")).toBe(
    'INFO http: POST /api/x 200 ms=12 id=r-1 why="two words"',
  );
});

test("an error field shows its message, and its stack when the level is error", () => {
  const { err, sink } = capture();
  const boom = new Error("disk full");
  log("usage", sink).warn("ingest failed", { err: boom });
  log("usage", sink).error("ingest failed", { err: boom });
  expect(err[0]?.replace(STAMP, "")).toBe('WARN usage: ingest failed err="disk full"');
  expect(err[1]?.split("\n")[0]?.replace(STAMP, "")).toBe(
    'ERROR usage: ingest failed err="disk full"',
  );
  expect(err[1]).toContain("at ");
});

test("a log past its size moves to .1, private, and its open writer goes on at the start", () => {
  const path = join(mkdtempSync(join(tmpdir(), "aos-log-")), "server.log");
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, "x".repeat(2000));
    expect(rotate(path, 5000)).toBe(false);
    expect(rotate(path, 1000)).toBe(true);
    expect(readFileSync(`${path}.1`, "utf8")).toBe("x".repeat(2000));
    expect(statSync(`${path}.1`).mode & 0o777).toBe(0o600);
    writeSync(fd, "next\n");
    expect(readFileSync(path, "utf8")).toBe("next\n");
    writeSync(fd, "y".repeat(2000));
    expect(rotate(path, 1000)).toBe(true);
    expect(readFileSync(`${path}.1`, "utf8")).toBe(`next\n${"y".repeat(2000)}`);
  } finally {
    closeSync(fd);
  }
  expect(rotate(join(path, "missing"), 1)).toBe(false);
});

test("a log the shell created 0644 is made private; a missing one is no failure", () => {
  const path = join(mkdtempSync(join(tmpdir(), "aos-log-")), "server.log");
  writeFileSync(path, "line\n", { mode: 0o644 });
  expect(statSync(path).mode & 0o777).toBe(0o644);
  expect(makePrivate(path)).toBeNull();
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(makePrivate(join(path, "..", "missing.log"))).toBeNull();
  expect(makePrivate(join(path, "not-a-dir", "x.log"))).toBeInstanceOf(Error);
});

test("a URL in a line keeps its path, never its query", () => {
  const { err, sink } = capture();
  log("google", sink).warn("callback at https://x.test/cb?code=secret", {
    url: "see http://h.test/a/b?token=t#frag now",
  });
  expect(err[0]?.replace(STAMP, "")).toBe(
    'WARN google: callback at https://x.test/cb url="see http://h.test/a/b now"',
  );
});
