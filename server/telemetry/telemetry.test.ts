import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context, propagation, ROOT_CONTEXT, type Span, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { AlwaysOnSampler, TracerProvider } from "@opentelemetry/sdk-trace";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { cached } from "../cache.ts";
import { quota } from "../features/google/client.ts";
import { log } from "../log.ts";
import { run, verbOf } from "../run.ts";
import { bucketOf, emptyHisto, LAST, quantile, record } from "./histogram.ts";
import { shownQuery, traceRequests } from "./http.ts";
import {
  ERRORS_PER_HOUR,
  MAX_SPANS_PER_TRACE,
  OPEN_MAX_MS,
  SAMPLE,
  SAMPLE_SPANS,
  SAMPLES_PER_HOUR,
  SLOW_PER_HOUR,
  TailProcessor,
} from "./processor.ts";
import { markError, pathTemplate, traced, traceId } from "./span.ts";
import {
  errorGroups,
  openTelemetry,
  prune,
  type RootRow,
  routeHistos,
  type SpanRow,
  since,
  slowest,
  summary,
  traceOf,
  VERSION,
  versionOf,
  writeBatch,
} from "./store.ts";

let db: Database;
let processor: TailProcessor;
let clock = Date.parse("2026-10-24T10:00:30.000Z");
let failWrites = false;

beforeEach(() => {
  db = openTelemetry(":memory:");
  failWrites = false;
  processor = new TailProcessor({
    proc: "server",
    now: () => clock,
    tickMs: 3_600_000,
    write: (s, r, h) => {
      if (failWrites) throw new Error("disk full");
      writeBatch(db, s, r, h);
    },
  });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(
    new TracerProvider({ sampler: new AlwaysOnSampler(), spanProcessors: [processor] }),
  );
});

afterEach(async () => {
  await processor.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
  db.close();
});

// A trace id the 1-in-SAMPLE pick keeps, or skips.
const PICKED = `${"0".repeat(24)}${(SAMPLE * 7).toString(16).padStart(8, "0")}`;
let n = 0;
const skipped = () => `${"0".repeat(24)}${(SAMPLE * ++n + 1).toString(16).padStart(8, "0")}`;
const SKIPPED = skipped();
const picked = (k: number) =>
  `${"0".repeat(24)}${(SAMPLE * (100 + k)).toString(16).padStart(8, "0")}`;
const parentOf = (traceId: string) => `00-${traceId}-${"1".repeat(16)}-01`;

const app = () =>
  new Hono()
    .use("*", traceRequests())
    .use("*", async (c, next) => {
      c.header("x-trace-id", traceId());
      trace.getActiveSpan()?.setAttribute("request.id", c.req.header("x-test-id") ?? "r");
      await next();
    })
    .get("/api/items/:id", async (c) => {
      await traced("jira GET /rest/api/3/issue", "jira", {}, async () => {
        await fetch("data:,x");
        await Bun.sleep(1);
      });
      return c.json({ id: c.req.param("id") });
    })
    .post("/api/items", (c) => c.json({ ok: true }))
    .get("/api/slow", async (c) => {
      await Bun.sleep(320);
      return c.text("ok");
    })
    .get("/api/boom", () => {
      throw new Error("kaput");
    })
    .get("/api/refused", () => {
      throw new HTTPException(400, { message: "no such folder" });
    })
    .get("/api/handled", (c) => {
      markError("ingest: 3 files unreadable");
      return c.json({ ok: true });
    })
    .get("/api/offline", (c) => c.json({ error: "machine_offline" }, 503, { "retry-after": "30" }))
    .get("/api/logged", (c) => {
      log("jira", lines.sink).error("fetch failed", {
        err: new Error("ECONNRESET"),
        token: "s3cret",
        ms: 4,
      });
      return c.json({ error: "jira_failed" }, 502);
    })
    .get("/api/issue/:key", (c) => {
      markError(`Jira 404 on /rest/api/3/issue/${c.req.param("key")}`);
      return c.json({ error: "not_found" }, 404);
    })
    .get("/api/later", (c) => {
      // Work a request sets going that outlives it.
      setTimeout(
        () =>
          void traced("refresh", "cmd", {}, async () => log("refresh", lines.sink).info("tick")),
        5,
      );
      return c.text("ok");
    })
    .get("/api/events", (c) => c.text("stream"));

const lines = {
  out: [] as string[],
  sink: { log: (l: string) => lines.out.push(l), error: (l: string) => lines.out.push(l) },
};

const get = (path: string, headers: Record<string, string> = {}) =>
  app().request(path, { headers });

describe("histogram", () => {
  test("a quantile is within 2^(1/8) (9.05 %) of the true value, never above the slowest seen", () => {
    for (const ms of [0.4, 3, 47, 312, 5_033, 94_708]) {
      const h = emptyHisto();
      record(h, ms, false);
      record(h, ms * 2, false);
      expect(Math.abs(quantile(h, 0.5) / ms - 1)).toBeLessThan(2 ** 0.125 - 1 + 1e-9);
    }
    const h = emptyHisto();
    for (const ms of [3, 4, 8, 40, 45, 48, 49, 50, 900, 1_500]) record(h, ms, ms > 1_000);
    expect([quantile(h, 0.95), h.max, h.errors]).toEqual([1_500, 1_500, 1]);
    // A 20 % slowdown lands in another bucket.
    expect(bucketOf(1_000)).not.toBe(bucketOf(1_200));
    expect(bucketOf(1e9)).toBe(LAST);
    // Sparse: only the buckets that saw a request.
    expect(Object.keys(h.buckets).length).toBeLessThan(10);
  });
});

describe("requests", () => {
  test("named by route, outside calls nested, the trace id in the header", async () => {
    const res = await get("/api/items/42", { traceparent: parentOf(PICKED) });
    processor.write(true);
    const id = res.headers.get("x-trace-id");
    expect(id).toBe(PICKED);
    const { root, spans } = traceOf(db, "r");
    expect(root?.kept).toBe("sample");
    const server = spans.find((s) => s.name === "GET /api/items/:id");
    const jira = spans.find((s) => s.name === "jira GET /rest/api/3/issue");
    // The caller's span is remote, so the request is this process's local root.
    expect(server?.local_root).toBe(1);
    expect(jira?.parent_id).toBe(server?.span_id ?? "none");
  });

  test("a query keeps only the keys and values it may", () => {
    const shown = shownQuery(
      new URL("http://x/auth/google/callback?code=SECRET&fresh=1&day=2026-10-24&tab=x;drop"),
    );
    expect(shown).toBe("?fresh=1&day=2026-10-24");
  });

  test("errors kept with their cause; a handled failure too; the PC known down and a 4xx are not", async () => {
    await get("/api/boom", { traceparent: parentOf(skipped()) });
    expect((await get("/api/refused", { traceparent: parentOf(skipped()) })).status).toBe(400);
    await get("/api/handled", { traceparent: parentOf(skipped()) });
    await get("/api/offline", { traceparent: parentOf(skipped()) });
    processor.write(true);
    const groups = errorGroups(db, 0);
    expect(groups.map((g) => [g.name, g.error]).sort()).toEqual([
      ["GET /api/boom", "GET /api/boom: kaput"],
      ["GET /api/handled", "GET /api/handled: ingest: 3 files unreadable"],
    ]);
  });

  test("a log line inside a request names its trace and lands on its span, without secrets", async () => {
    const res = await get("/api/logged", {
      traceparent: parentOf(skipped()),
      "x-test-id": "r-log",
    });
    processor.write(true);
    const id = res.headers.get("x-trace-id") ?? "none";
    expect(lines.out.at(-1)).toContain(`trace=${id}`);
    const { root, spans } = traceOf(db, "r-log");
    expect(root?.kept).toBe("error");
    const events = JSON.parse(spans[0]?.events ?? "[]");
    expect(events[0]).toMatchObject({
      name: "log",
      level: "error",
      scope: "jira",
      err: "ECONNRESET",
      ms: 4,
    });
    expect(events[0].token).toBeUndefined();
  });

  test("one failure with different ids is one group, counted in full and kept whole a few times", async () => {
    for (let i = 0; i < ERRORS_PER_HOUR + 2; i++)
      await get(`/api/issue/ABC-${100 + i}`, { traceparent: parentOf(skipped()) });
    processor.write(true);
    const groups = errorGroups(db, 0);
    expect(groups.map((g) => [g.name, g.count])).toEqual([
      ["GET /api/issue/:key", ERRORS_PER_HOUR + 2],
    ]);
    expect(groups[0]?.error).toBe(
      `GET /api/issue/:key: Jira 404 on /rest/api/3/issue/ABC-${101 + ERRORS_PER_HOUR}`,
    );
    const kept = db
      .query<{ n: number }, []>("SELECT count(*) AS n FROM roots WHERE kept = 'error'")
      .get();
    expect(kept?.n).toBe(ERRORS_PER_HOUR);
  });

  test("work that outlives its request is a trace of its own, timed as an outside call", async () => {
    const res = await get("/api/later", { traceparent: parentOf(skipped()) });
    await Bun.sleep(30);
    processor.write(true);
    const own = /trace=(\w+)/.exec(lines.out.at(-1) ?? "")?.[1];
    expect(own).toBeString();
    expect(own).not.toBe(res.headers.get("x-trace-id") ?? "");
    expect(slowest(db, 0).find((r) => r.key === "refresh")?.metric).toBe("op");
    expect(slowest(db, 0).find((r) => r.key === "GET /api/later")?.metric).toBe("route");
  });

  test("streams are not traced", async () => {
    const res = await get("/api/events");
    processor.write(true);
    expect(res.headers.get("x-trace-id")).toBe("");
    expect(summary(db, ":memory:").roots).toBe(0);
  });

  test("a fast correct read not sampled is only counted; a write keeps its line", async () => {
    await get("/api/items/1", { traceparent: parentOf(SKIPPED), "x-test-id": "r-skip" });
    await app().request("/api/items", {
      method: "POST",
      headers: { traceparent: parentOf(skipped()), "x-test-id": "r-write" },
    });
    processor.write(true);
    expect(traceOf(db, "r-skip")).toEqual({ root: null, spans: [] });
    expect(slowest(db, 0).find((r) => r.key === "GET /api/items/:id")?.n).toBe(1);
    const { root, spans } = traceOf(db, "r-write");
    expect([root?.kept, spans.length]).toEqual(["", 0]);
  });

  test("a route keeps a few healthy samples an hour, not every pick", async () => {
    for (let i = 0; i < SAMPLES_PER_HOUR + 3; i++)
      await get("/api/items/1", { traceparent: parentOf(picked(i)) });
    processor.write(true);
    const kept = db
      .query<{ n: number }, []>("SELECT count(*) AS n FROM roots WHERE kept = 'sample'")
      .get()?.n;
    expect(kept).toBe(SAMPLES_PER_HOUR);
    // Every call is still timed.
    expect(slowest(db, 0).find((r) => r.key === "GET /api/items/:id")?.n).toBe(
      SAMPLES_PER_HOUR + 3,
    );
  });

  test("full mode stores every request whole until it ends", async () => {
    processor.fullUntil = clock + 60_000;
    await get("/api/items/1", { traceparent: parentOf(skipped()), "x-test-id": "r-full" });
    processor.fullUntil = 0;
    await get("/api/items/2", { traceparent: parentOf(skipped()), "x-test-id": "r-after" });
    processor.write(true);
    expect(
      traceOf(db, "r-full")
        .spans.map((s) => s.name)
        .sort(),
    ).toEqual(["GET /api/items/:id", "jira GET /rest/api/3/issue"]);
    expect(traceOf(db, "r-after").root).toBeNull();
  });

  test("slower than its route usually is: kept, at most a few an hour", async () => {
    for (let i = 0; i < SLOW_PER_HOUR + 1; i++)
      await get("/api/slow", { traceparent: parentOf(skipped()) });
    processor.write(true);
    const kept = db
      .query<{ n: number }, []>("SELECT count(*) AS n FROM roots WHERE kept = 'slow'")
      .get();
    expect(kept?.n).toBe(SLOW_PER_HOUR);
    const [slow] = slowest(db, 0).filter((r) => r.key === "GET /api/slow");
    expect(slow?.n).toBe(SLOW_PER_HOUR + 1);
    expect(slow?.p95).toBeGreaterThanOrEqual(320 / 2 ** 0.125);
  });
});

describe("processor", () => {
  const tracer = () => trace.getTracer("t");

  test("a span that ends after its trace was decided follows the decision", async () => {
    let late: Span | undefined;
    await tracer().startActiveSpan("GET /root", (root) => {
      late = tracer().startSpan("refresh");
      root.setStatus({ code: 2, message: "x" });
      root.end();
    });
    late?.end();
    processor.write(true);
    expect(summary(db, ":memory:").spans).toBe(2);
  });

  test("a trace too big keeps its root and its errors", () => {
    tracer().startActiveSpan("GET /big", (root) => {
      for (let i = 0; i < MAX_SPANS_PER_TRACE + 10; i++) tracer().startSpan(`s${i}`).end();
      const bad = tracer().startSpan("bad");
      bad.setStatus({ code: 2, message: "no" });
      bad.end();
      root.end();
    });
    processor.write(true);
    const names = db
      .query<{ name: string }, []>("SELECT name FROM spans")
      .all()
      .map((r) => r.name);
    expect(names.length).toBe(MAX_SPANS_PER_TRACE + 2);
    expect(names).toContain("bad");
    expect(names).toContain("GET /big");
    expect(processor.stats.dropped).toBe(10);
  });

  test("a healthy sample keeps its root and its longest spans only", async () => {
    const picked = propagation.extract(ROOT_CONTEXT, { traceparent: parentOf(PICKED) });
    await tracer().startActiveSpan("GET /scan", { kind: SpanKind.SERVER }, picked, async (root) => {
      for (let i = 0; i < SAMPLE_SPANS + 5; i++) tracer().startSpan(`git ${i}`).end();
      const long = tracer().startSpan("git slowest");
      await Bun.sleep(5);
      long.end();
      root.end();
    });
    processor.write(true);
    expect(db.query<{ kept: string }, []>("SELECT kept FROM roots").get()?.kept).toBe("sample");
    const names = db
      .query<{ name: string }, []>("SELECT name FROM spans")
      .all()
      .map((r) => r.name);
    expect(names.length).toBe(SAMPLE_SPANS);
    expect(names).toContain("GET /scan");
    expect(names).toContain("git slowest");
  });

  test("the event loop's lateness is a minute measure of the process", () => {
    processor.gauge("event loop p99", 42);
    processor.write(true);
    const row = db
      .query<{ metric: string; key: string; max: number }, []>(
        "SELECT metric, key, max FROM histo_minute",
      )
      .get();
    expect(row).toEqual({ metric: "process", key: "event loop p99", max: 42 });
  });

  test("a root that never ends is let go; with an error inside it is kept as incomplete", () => {
    tracer().startActiveSpan("GET /hung", () => {
      const s = tracer().startSpan("pc GET /api/ai");
      s.setStatus({ code: 2, message: "timeout" });
      s.end();
    });
    clock += OPEN_MAX_MS + 1;
    processor.tick();
    processor.write(true);
    expect(
      traceOf(db, db.query<{ t: string }, []>("SELECT trace_id AS t FROM spans").get()?.t ?? "")
        .root?.kept,
    ).toBe("incomplete");
  });

  test("a failed write is counted, never thrown", () => {
    failWrites = true;
    tracer().startActiveSpan("GET /x", (root) => {
      root.setStatus({ code: 2 });
      root.end();
    });
    processor.write(true);
    expect(processor.stats.lost).toBeGreaterThan(0);
    expect(processor.stats.lastError).toBe("disk full");
  });

  test("context survives await, fetch and timers inside a traced call", async () => {
    let inner = "";
    await traced("outer", "cmd", {}, async (outer) => {
      await fetch("data:,x");
      await new Promise((r) => setTimeout(r, 5));
      await traced("inner", "cmd", {}, async (s) => {
        inner = s.spanContext().traceId === outer.spanContext().traceId ? "same" : "other";
      });
    });
    expect(inner).toBe("same");
  });
});

describe("outside calls", () => {
  test("a path as a span name: no query, ids as :id, a short version kept", () => {
    expect(pathTemplate("/rest/api/3/issue/ABC-123?fields=x")).toBe("/rest/api/3/issue/:id");
    expect(pathTemplate("/gmail/v1/users/me/messages/18c2f3a9")).toBe(
      "/gmail/v1/users/me/messages/:id",
    );
  });

  test("a command is a span named by program and verb, its timeout an error", async () => {
    await trace.getTracer("t").startActiveSpan("GET /cmd", async (root) => {
      await run(["/bin/echo", "-n", "hello", "/tmp/secret-path"], {
        timeoutMs: 5_000,
        cwd: "/tmp",
      });
      await run(["/bin/sleep", "5"], { timeoutMs: 50 });
      root.end();
    });
    processor.write(true);
    const spans = db
      .query<{ name: string; status: number; attrs: string }, []>(
        "SELECT name, status, attrs FROM spans ORDER BY start_ms",
      )
      .all();
    expect(spans.map((s) => [s.name, s.status]).sort()).toEqual([
      ["GET /cmd", 0],
      ["echo hello", 0],
      ["sleep", 2],
    ]);
    expect(JSON.parse(spans.find((s) => s.name === "echo hello")?.attrs ?? "{}")).toMatchObject({
      "aos.op": "cmd",
      "cmd.cwd": "tmp",
      "cmd.exit_code": 0,
    });
  });

  test("a shell or a runtime is named by what it runs, never by its free text", () => {
    expect(verbOf("zsh", ["-lic", "printf x; env -0"])).toBe("printf");
    expect(verbOf("bash", ["-c", "/usr/bin/git status"])).toBe("git");
    expect(verbOf("sh", ["-c", "'quoted text'"])).toBeUndefined();
    expect(verbOf("bun", ["/repo/scripts/refresh.ts", "--x"])).toBe("refresh.ts");
    expect(verbOf("git", ["-C", "/repo", "status"])).toBe("status");
  });

  test("joining a load in flight is a wait span naming the trace that loads", async () => {
    let finish = (_: string) => {};
    const c = cached(() => new Promise<string>((r) => (finish = r)));
    processor.fullUntil = Number.POSITIVE_INFINITY;
    const tracer = trace.getTracer("t");
    const [starter, joiner] = await Promise.all(
      ["first", "second"].map((name, i) =>
        tracer.startActiveSpan(`GET /${name}`, { kind: SpanKind.SERVER }, async (span) => {
          const got = c.get();
          if (i === 1) finish("v");
          await got;
          span.end();
          return span.spanContext().traceId;
        }),
      ),
    );
    processor.write(true);
    const wait = traceOf(db, joiner ?? "").spans.find((s) => s.name === "cache wait");
    expect(JSON.parse(wait?.attrs ?? "{}")["joined.trace"]).toBe(starter);
  });

  test("a refresh behind a kept value is a trace of its own, naming the request", async () => {
    const c = cached(async () => "new", {
      ttlMs: 10,
      now: () => clock,
      onChange: () => {},
      initial: { at: clock - 60_000, value: "old" },
    });
    processor.fullUntil = Number.POSITIVE_INFINITY;
    const request = await trace.getTracer("t").startActiveSpan("GET /kept", async (span) => {
      expect(await c.get()).toBe("old");
      span.end();
      return span.spanContext().traceId;
    });
    await Bun.sleep(1);
    processor.write(true);
    const refresh = db
      .query<{ trace_id: string; attrs: string }, []>(
        "SELECT trace_id, attrs FROM spans WHERE name = 'cache refresh'",
      )
      .get();
    expect(refresh?.trace_id).not.toBe(request);
    expect(JSON.parse(refresh?.attrs ?? "{}")["from.trace"]).toBe(request);
  });

  test("a wait for Gmail's quota is a span, not time with nothing under it", async () => {
    const spend = quota(0, 1_000);
    processor.fullUntil = Number.POSITIVE_INFINITY;
    await trace.getTracer("t").startActiveSpan("GET /profile", async (span) => {
      await spend(5);
      span.end();
    });
    processor.write(true);
    const wait = db
      .query<{ dur_ms: number }, []>("SELECT dur_ms FROM spans WHERE name = 'gmail quota wait'")
      .get();
    expect(wait?.dur_ms).toBeGreaterThanOrEqual(4);
  });

  test("a call made inside another is timed once, as the outer one", async () => {
    await traced("mac Helper inbox", "mac", {}, () =>
      run(["/bin/echo", "x"], { timeoutMs: 5_000, name: "open" }),
    );
    processor.write(true);
    const ops = db
      .query<{ key: string }, []>("SELECT key FROM histo_minute WHERE metric = 'op'")
      .all()
      .map((r) => r.key);
    expect(ops).toEqual(["mac Helper inbox"]);
  });
});

describe("store", () => {
  const root = (over: Partial<RootRow>): RootRow => ({
    trace_id: "t",
    request_id: null,
    name: "GET /a",
    proc: "server",
    start_ms: clock,
    dur_ms: 5,
    status: 0,
    error: null,
    kept: "",
    ...over,
  });

  test("a version 2 file keeps its traces and starts its histograms over", () => {
    const dir = mkdtempSync(join(tmpdir(), "telemetry-v2-"));
    const path = join(dir, "telemetry.db");
    const old = openTelemetry(path);
    writeBatch(old, [], [root({})], []);
    old.exec(
      "DROP TABLE histo_minute; CREATE TABLE histo_minute (minute INTEGER, metric TEXT, key TEXT, n INTEGER, errors INTEGER, sum REAL, max REAL, buckets TEXT, PRIMARY KEY (minute, metric, key)) WITHOUT ROWID; PRAGMA user_version = 2;",
    );
    old.exec(`INSERT INTO histo_minute VALUES (1, 'route', 'GET /a', 1, 0, 5, 5, '[0,1]')`);
    old.close();
    const db2 = openTelemetry(path, true);
    expect(versionOf(db2)).toBe(2);
    db2.close();
    const db3 = openTelemetry(path);
    expect([versionOf(db3), summary(db3, path).roots, routeHistos(db3, 0).size]).toEqual([
      VERSION,
      1,
      0,
    ]);
    db3.close();
  });

  test("since: a cursor of arrival, failures and slow ones only", () => {
    writeBatch(db, [], [root({ status: 2, error: "x" }), root({}), root({ kept: "slow" })], []);
    const first = since(db, 0);
    expect(first.roots.length).toBe(2);
    writeBatch(db, [], [root({ status: 2, error: "y" })], []);
    const next = since(db, first.cursor);
    expect(next.roots.map((r) => r.error)).toEqual(["y"]);
  });

  test("prune keeps traces whole for 30 days, of every kind", () => {
    const day = 86_400_000;
    const spanOf = (trace_id: string, start_ms: number): SpanRow => ({
      trace_id,
      span_id: "s",
      parent_id: null,
      name: "GET /a",
      kind: 1,
      proc: "server",
      start_ms,
      dur_ms: 5,
      status: 0,
      error: null,
      local_root: 1,
      request_id: null,
      attrs: "{}",
      events: "[]",
    });
    writeBatch(
      db,
      [spanOf("sample29", clock - 29 * day), spanOf("slow31", clock - 31 * day)],
      [
        root({ trace_id: "sample29", kept: "sample", start_ms: clock - 29 * day }),
        root({ trace_id: "write29", start_ms: clock - 29 * day }),
        root({ trace_id: "slow31", kept: "slow", start_ms: clock - 31 * day }),
      ],
      [],
    );
    prune(db, clock, 1e12);
    const left = (table: string) =>
      db
        .query<{ trace_id: string }, []>(`SELECT trace_id FROM ${table} ORDER BY trace_id`)
        .all()
        .map((r) => r.trace_id);
    expect([left("spans"), left("roots")]).toEqual([["sample29"], ["sample29", "write29"]]);
  });

  test("over budget, whole days of traces go from the oldest, lines included", () => {
    const day = 86_400_000;
    writeBatch(
      db,
      [],
      [
        root({ trace_id: "error10", kept: "error", status: 2, start_ms: clock - 10 * day }),
        root({ trace_id: "error1", kept: "error", status: 2, start_ms: clock - day }),
      ],
      [],
    );
    // A budget of one page: everything but the newest day is cut.
    prune(db, clock, 1);
    const left = db
      .query<{ trace_id: string }, []>("SELECT trace_id FROM roots ORDER BY trace_id")
      .all()
      .map((r) => r.trace_id);
    expect(left).not.toContain("error10");
  });

  test("histograms thin out with age: 3-hour rows past 30 days, daily past 90, gone at 180", () => {
    const day = 86_400_000;
    const now = Date.parse("2026-10-25T12:00:00.000Z");
    const minuteAgo = (days: number) => Math.floor((now - days * day) / 60_000);
    const one = (ms: number) => {
      const h = emptyHisto();
      record(h, ms, false);
      return h;
    };
    // Two calls in the same 3 hours 40 days ago, two on one day 100 days ago, one 200 days ago,
    // one today.
    const old = minuteAgo(40) - (minuteAgo(40) % 180);
    const older = minuteAgo(100) - (minuteAgo(100) % 1_440);
    writeBatch(
      db,
      [],
      [],
      [
        { minute: old + 5, metric: "route", key: "GET /a", h: one(10) },
        { minute: old + 170, metric: "route", key: "GET /a", h: one(1_000) },
        { minute: older + 3, metric: "route", key: "GET /a", h: one(20) },
        { minute: older + 900, metric: "route", key: "GET /a", h: one(30) },
        { minute: minuteAgo(200), metric: "route", key: "GET /a", h: one(40) },
        { minute: minuteAgo(0), metric: "route", key: "GET /a", h: one(50) },
      ],
    );
    prune(db, now, 1e12);
    const rows = () =>
      db
        .query<{ minute: number; n: number; max: number }, []>(
          "SELECT minute, n, max FROM histo_minute ORDER BY minute",
        )
        .all();
    expect(rows()).toEqual([
      { minute: older, n: 2, max: 30 },
      { minute: old, n: 2, max: 1_000 },
      { minute: minuteAgo(0), n: 1, max: 50 },
    ]);
    // Nothing aged since: a second pass changes nothing, and the quantiles read the same.
    prune(db, now, 1e12);
    expect(rows().length).toBe(3);
    expect(quantile(routeHistos(db, now - 50 * day).get("GET /a") ?? emptyHisto(), 1)).toBe(1_000);
  });

  test("a minute written twice adds up", () => {
    const h = emptyHisto();
    record(h, 10, false);
    writeBatch(db, [], [], [{ minute: 1, metric: "route", key: "GET /a", h }]);
    writeBatch(db, [], [], [{ minute: 1, metric: "route", key: "GET /a", h }]);
    expect(routeHistos(db, 0).get("GET /a")?.n).toBe(2);
  });
});
