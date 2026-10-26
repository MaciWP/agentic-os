import { afterEach, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import { z } from "zod";
import { createApp } from "./app.ts";
import { ConfigSchema } from "./config.ts";
import { openDb } from "./db.ts";
import { CoordinationError } from "./features/coordination/store.ts";
import { FileError } from "./features/files/browse.ts";
import { GitError } from "./features/git/run.ts";
import { GitRefusal } from "./features/git/sync.ts";
import { ImageError } from "./features/images/store.ts";
import { ReconnectRequired } from "./features/jira/oauth.ts";
import { KickoffBusy } from "./features/kickoff/run.ts";
import { MemoryError } from "./features/memory/store.ts";
import { LaunchError } from "./features/terminals/harness.ts";
import { HostUnavailable } from "./features/terminals/host-client.ts";
import { TerminalManager } from "./features/terminals/pty.ts";
import { AttachTokens } from "./features/terminals/ws-guard.ts";
import { VoiceError } from "./features/voice/engine.ts";
import { WorkspaceConflict } from "./features/workspace/store.ts";
import { ProviderError } from "./provider-error.ts";
import { TailProcessor } from "./telemetry/processor.ts";
import { openTelemetry, traceOf, writeBatch } from "./telemetry/store.ts";

let spies: Mock<(...args: unknown[]) => void>[] = [];
beforeEach(() => {
  spies = [
    spyOn(console, "log").mockImplementation(() => {}),
    spyOn(console, "error").mockImplementation(() => {}),
  ];
});
afterEach(() => {
  for (const s of spies) s.mockRestore();
});

const config = ConfigSchema.parse({ port: 4317, terminals: { shell: "/bin/sh" } });
const db = openDb(":memory:");
const terminals = new TerminalManager(config, db, () => Promise.resolve({}));
const app = createApp({ config, db, terminals, tokens: new AttachTokens() });
const headers = {
  host: "127.0.0.1:4317",
  origin: "http://127.0.0.1:4317",
  "content-type": "application/json",
};
const lines = () => spies.flatMap((s) => s.mock.calls.map((c) => String(c[0])));

test("a read that works leaves no request line", async () => {
  expect((await app.request("/api/health", { headers })).status).toBe(200);
  expect(lines()).toEqual([]);
});

// Each reading of the clock a second after the last, so any request takes at least a second.
const slowClock = () => {
  let t = 0;
  return spyOn(performance, "now").mockImplementation(() => (t += 1_000));
};

test("a slow read leaves one line with its time", async () => {
  const clock = slowClock();
  try {
    expect((await app.request("/api/health", { headers })).status).toBe(200);
  } finally {
    clock.mockRestore();
  }
  const [line, ...rest] = lines();
  expect(rest).toEqual([]);
  expect(line).toMatch(/INFO http: GET \/api\/health 200 ms=\d{4,}/);
});

test("a stream is never a slow read", async () => {
  const clock = slowClock();
  try {
    const res = await app.request("/api/events", { headers });
    expect(res.headers.get("content-type")).toStartWith("text/event-stream");
    await res.body?.cancel();
  } finally {
    clock.mockRestore();
  }
  expect(lines()).toEqual([]);
});

test("JSON goes out compressed to a client that takes gzip; the events stream never", async () => {
  const gzip = { ...headers, "accept-encoding": "gzip" };
  const json = await app.request("/api/coordination/capabilities", { headers: gzip });
  expect(json.headers.get("content-encoding")).toBe("gzip");
  const body = new TextDecoder().decode(Bun.gunzipSync(await json.arrayBuffer()));
  expect(JSON.parse(body)).toBeObject();
  const events = await app.request("/api/events", { headers: gzip });
  expect(events.headers.get("content-encoding")).toBeNull();
  await events.body?.cancel();
});

test("a compressed failure still logs its cause", async () => {
  spyOn(terminals, "list").mockImplementationOnce(() => {
    throw new HostUnavailable(`host gone ${"x".repeat(2_000)}`);
  });
  const res = await app.request("/api/terminals", {
    headers: { ...headers, "accept-encoding": "gzip" },
  });
  expect([res.status, res.headers.get("content-encoding")]).toEqual([503, "gzip"]);
  expect(lines().join("\n")).toContain("error=pty_host_unavailable");
});

test("a change leaves one line with method, path, status, time and request id, never the query", async () => {
  const res = await app.request("/api/workspace/commands?code=secret-code", {
    method: "POST",
    headers,
    body: "{}",
  });
  expect(res.status).toBe(400);
  const [line, ...rest] = lines();
  expect(rest).toEqual([]);
  expect(line).toContain("INFO http: POST /api/workspace/commands 400 ms=");
  expect(line).toContain(`request=${res.headers.get("x-request-id")}`);
  expect(line).not.toContain("secret-code");
});

test("a workboard heartbeat leaves no request line, accepted or refused", async () => {
  const res = await app.request("/api/workboard/session", { method: "POST", headers, body: "{}" });
  expect(res.status).toBe(400);
  expect(lines()).toEqual([]);
});

test("an internal 500 logs its cause, not only its type", async () => {
  spyOn(terminals, "list").mockImplementationOnce(() => {
    throw new Error("disk on fire");
  });
  const res = await app.request("/api/terminals", { headers });
  expect(res.status).toBe(500);
  expect((await res.json()).error).toBe("internal");
  expect(lines().join("\n")).toContain("disk on fire");
});

test("a known server failure's line says which one and why", async () => {
  spyOn(terminals, "list").mockImplementationOnce(() => {
    throw new HostUnavailable("host gone");
  });
  expect((await app.request("/api/terminals", { headers })).status).toBe(503);
  const [line] = lines();
  expect(line).toContain("ERROR http: GET /api/terminals 503");
  expect(line).toContain('error=pty_host_unavailable detail="host gone"');
});

test("a data shape failure logs where the data broke", async () => {
  spyOn(terminals, "list").mockImplementationOnce(() => {
    throw z.object({ id: z.number() }).safeParse({ id: "x" }).error as Error;
  });
  expect((await app.request("/api/terminals", { headers })).status).toBe(500);
  expect(lines().join("\n")).toMatch(/data_shape .*issues="id: /);
});

test("a worker held down leaves one machines line, not one request line per poll", async () => {
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const origin = `http://127.0.0.1:${closed.port}`;
  closed.stop(true);
  // The schema wants a Tailscale HTTPS origin; a local dead port stands in for a PC that is off.
  const hubConfig = { ...config, machines: [{ id: "pc", label: "PC", origin }] };
  const hub = createApp({
    config: hubConfig,
    db,
    terminals,
    tokens: new AttachTokens(),
  });
  expect((await hub.request("/api/machines/pc/ai", { headers })).status).toBe(502);
  expect((await hub.request("/api/machines/pc/ai", { headers })).status).toBe(503);
  expect((await hub.request("/api/machines/pc/ai", { headers })).status).toBe(503);
  const all = lines();
  expect(all.filter((l) => l.includes("WARN machines: PC down"))).toHaveLength(1);
  expect(all.filter((l) => l.includes("http: GET /api/machines/pc/ai"))).toHaveLength(1);
  expect(all.find((l) => l.includes("http:"))).toContain("error=machine_unreachable");
});

// Each known failure, thrown by a route, and the answer the client gets for it.
const ANSWERS: [string, Error, number, Record<string, unknown>][] = [
  [
    "unknown image",
    new ImageError("no such image", "unknown_image"),
    404,
    { error: "unknown_image", detail: "no such image" },
  ],
  [
    "capture busy",
    new ImageError("one at a time", "capture_busy"),
    409,
    { error: "capture_busy", detail: "one at a time" },
  ],
  [
    "file",
    new FileError(403, "no_access", "denied"),
    403,
    { error: "no_access", detail: "denied" },
  ],
  ["memory", new MemoryError(413, "too_big", "huge"), 413, { error: "too_big", detail: "huge" }],
  [
    "launch",
    new LaunchError("no such place"),
    400,
    { error: "launch_rejected", detail: "no such place" },
  ],
  ["kickoff busy", new KickoffBusy("running"), 409, { error: "busy", detail: "running" }],
  [
    "workspace conflict",
    new WorkspaceConflict("mesa_missing", { revision: 3, mesas: [], blocks: [] }),
    409,
    {
      error: "mesa_missing",
      detail: "mesa_missing",
      current: { revision: 3, mesas: [], blocks: [] },
    },
  ],
  [
    "git refusal",
    new GitRefusal("dirty", "has changes"),
    409,
    { error: "refused", reason: "dirty", detail: "has changes" },
  ],
  ["git", new GitError("git failed"), 502, { error: "git_error", detail: "git failed" }],
  [
    "coordination",
    new CoordinationError("not_found", "q1", 404),
    404,
    { error: "not_found", detail: "not_found: q1" },
  ],
  ["voice", new VoiceError("worker died"), 500, { error: "voice_failed", detail: "worker died" }],
  [
    "host",
    new HostUnavailable("host gone"),
    503,
    { error: "pty_host_unavailable", detail: "host gone" },
  ],
  [
    "reconnect",
    new ReconnectRequired("why"),
    401,
    { error: "reconnect_required", provider: "jira", detail: "Jira needs to be reconnected: why" },
  ],
  [
    "provider",
    new ProviderError("github", 500, "GitHub 500"),
    502,
    { error: "provider_error", provider: "github", status: 500, detail: "GitHub 500" },
  ],
  [
    "data shape",
    z.number().safeParse("x").error as Error,
    500,
    {
      error: "data_shape",
      detail: "Stored or internal data failed validation. See the request ID.",
    },
  ],
  [
    "anything else",
    new Error("boom"),
    500,
    { error: "internal", detail: "Unexpected server failure. See the request ID." },
  ],
];

test.each(ANSWERS)("a route's %s failure gets its own answer", async (_, err, status, body) => {
  spyOn(terminals, "list").mockImplementationOnce(() => {
    throw err;
  });
  const res = await app.request("/api/terminals", { headers });
  expect(res.status).toBe(status);
  expect(await res.json()).toEqual(body);
});

test("with tracing on, a server failure answers its trace id and keeps the trace with its cause", async () => {
  const tdb = openTelemetry(":memory:");
  const processor = new TailProcessor({
    proc: "server",
    write: (s, r, h) => writeBatch(tdb, s, r, h),
  });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [processor] }));
  try {
    spyOn(terminals, "list").mockImplementationOnce(() => {
      throw new HostUnavailable("host gone");
    });
    const res = await app.request("/api/terminals", { headers });
    processor.write(true);
    const id = res.headers.get("x-trace-id") ?? "none";
    const { root } = traceOf(tdb, res.headers.get("x-request-id") ?? "none");
    expect([root?.trace_id, root?.name, root?.kept]).toEqual([id, "GET /api/terminals", "error"]);
    expect(root?.error).toBe("GET /api/terminals: pty_host_unavailable: host gone");
    expect(lines().join("\n")).toContain(`trace=${id}`);
  } finally {
    await processor.shutdown();
    trace.disable();
    context.disable();
    tdb.close();
  }
});
