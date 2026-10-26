import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exclusive } from "../server/telemetry/health.ts";
import { emptyHisto, record } from "../server/telemetry/histogram.ts";
import {
  openTelemetry,
  type RootRow,
  type SpanRow,
  writeBatch,
} from "../server/telemetry/store.ts";
import { parseSince, trace } from "./aos-trace.ts";

const NOW = Date.parse("2026-10-24T10:00:00.000Z");
const T = "a".repeat(32);

const span = (over: Partial<SpanRow>): SpanRow => ({
  trace_id: T,
  span_id: "s0",
  parent_id: null,
  name: "GET /api/projects",
  kind: 1,
  proc: "server",
  start_ms: NOW - 60_000,
  dur_ms: 1_000,
  status: 0,
  error: null,
  local_root: 0,
  request_id: null,
  attrs: "{}",
  events: "[]",
  ...over,
});
const root = (over: Partial<RootRow>): RootRow => ({
  trace_id: T,
  request_id: "req-1",
  name: "GET /api/projects",
  proc: "server",
  start_ms: NOW - 60_000,
  dur_ms: 1_000,
  status: 2,
  error: "GET /api/projects: git status timed out",
  kept: "error",
  ...over,
});

// A data folder with one stored trace: a request, two git calls in parallel (one failed, with
// its log line) and a skipped request.
function folder() {
  const dir = mkdtempSync(join(tmpdir(), "aos-trace-"));
  const db = openTelemetry(join(dir, "telemetry.db"));
  const h = emptyHisto();
  record(h, 1_000, true);
  const g = emptyHisto();
  record(g, 900, true);
  writeBatch(
    db,
    [
      span({ span_id: "s0", local_root: 1, request_id: "req-1", status: 2 }),
      span({
        span_id: "s1",
        parent_id: "s0",
        name: "git status",
        start_ms: NOW - 59_950,
        dur_ms: 900,
        status: 2,
        error: "timed out",
        events: JSON.stringify([
          { name: "log", at_ms: 899, level: "error", scope: "git", msg: "status failed", ms: 1 },
        ]),
      }),
      span({
        span_id: "s2",
        parent_id: "s0",
        name: "git log",
        start_ms: NOW - 59_900,
        dur_ms: 500,
      }),
    ],
    [
      root({}),
      root({ trace_id: "b".repeat(32), request_id: "req-2", status: 0, error: null, kept: "" }),
    ],
    [
      { minute: Math.floor((NOW - 60_000) / 60_000), metric: "route", key: "GET /api/projects", h },
      { minute: Math.floor((NOW - 60_000) / 60_000), metric: "op", key: "git status", h: g },
    ],
  );
  db.close();
  return dir;
}

const runTrace = async (dir: string, sub: string, extra: Record<string, unknown> = {}) => {
  const out: string[] = [];
  const asked: string[] = [];
  const api = async (method: string, path: string) => {
    asked.push(`${method} ${path}`);
    throw new Error("down");
  };
  const code = await trace({ sub, ...extra }, api, (s) => out.push(s), dir, NOW);
  return { code, text: out.join("\n"), asked };
};

test("parallel children count once in a span's own time", () => {
  const parent = span({ start_ms: 0, dur_ms: 1_000 });
  const kids = [span({ start_ms: 50, dur_ms: 900 }), span({ start_ms: 100, dur_ms: 500 })];
  expect(exclusive(parent, kids)).toBe(100);
});

test("--since reads 15m, 2h, 1d and refuses anything else", () => {
  expect(parseSince("15m", 0)).toBe(900_000);
  expect(parseSince(undefined, 7)).toBe(7);
  expect(() => parseSince("soon", 0)).toThrow("--since");
});

test("errors: grouped by route and cause, with a trace to open; read with the server down", async () => {
  const { code, text, asked } = await runTrace(folder(), "errors");
  expect(code).toBe(0);
  expect(text).toBe(
    `1× GET /api/projects · GET /api/projects: git status timed out · last ${new Date(NOW - 60_000).toLocaleTimeString("es-ES", { hour12: false })} · trace ${T}`,
  );
  expect(asked).toEqual([]);
});

test("slow: requests and outside calls apart, the worst trace named", async () => {
  const { text } = await runTrace(folder(), "slow");
  expect(text).toContain(
    `GET /api/projects · p50 1000 ms p95 1000 ms max 1000 ms · 1 calls, 1 failed · trace ${T}`,
  );
  expect(text).toContain("outside calls and waits:\ngit status · p50 893 ms p95 893 ms max 900 ms");
});

test("an id: the waterfall with own time, the failure and its log line", async () => {
  const { text } = await runTrace(folder(), "req-1");
  const lines = text.split("\n");
  expect(lines[0]).toStartWith(
    "GET /api/projects · 1000 ms · ERROR GET /api/projects: git status timed out · error",
  );
  expect(lines).toContain("+0 ms 1000 ms (self 100 ms) GET /api/projects ERROR");
  expect(lines).toContain("  +50 ms 900 ms git status ERROR timed out");
  expect(lines).toContain("    · +899 ms ERROR git: status failed ms=1");
});

test("a request that was not sampled says so instead of not found", async () => {
  const { code, text } = await runTrace(folder(), "req-2");
  expect(code).toBe(0);
  expect(text).toContain("not sampled: only this line was stored");
});

test("since: failures after the cursor, and the next cursor; --flush asks the server first", async () => {
  const { text, asked } = await runTrace(folder(), "since", { arg: "0", flush: true });
  expect(asked).toEqual(["POST /api/telemetry/flush"]);
  expect(text).toContain("(server not reachable: reading the file as it is)");
  expect(text).toContain(`ERROR GET /api/projects: git status timed out · trace ${T}`);
  expect(text.split("\n").at(-1)).toBe("cursor 2");
});

test("--json gives every field, attributes parsed", async () => {
  const { text } = await runTrace(folder(), T, { json: true });
  const data = JSON.parse(text);
  expect(data.spans).toHaveLength(3);
  expect(data.spans[1].events[0].msg).toBe("status failed");
});

test("an unknown id is an error, not an empty answer", async () => {
  const { code, text } = await runTrace(folder(), "nope");
  expect(code).toBe(1);
  expect(text).toContain("no trace or request nope");
});

test("full: asks the server to store every request, for an hour by default or until off", async () => {
  const asked: unknown[] = [];
  const out: string[] = [];
  const api = async (_m: string, _p: string, body?: unknown) => {
    asked.push(body);
    return { fullUntil: (body as { minutes: number }).minutes ? NOW + 3_600_000 : null };
  };
  await trace({ sub: "full" }, api, (s) => out.push(s), "/nowhere", NOW);
  await trace({ sub: "full", arg: "off" }, api, (s) => out.push(s), "/nowhere", NOW);
  expect(asked).toEqual([{ minutes: 60 }, { minutes: 0 }]);
  expect(out[1]).toBe("full tracing off");
  await expect(trace({ sub: "full", arg: "soon" }, api, () => {}, "/nowhere", NOW)).rejects.toThrow(
    "minutes",
  );
});
