import { afterAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { upgradeWebSocket, websocket } from "hono/bun";
import { breaker, machineRoutes, offlineReason, relayCode, upstreamUrl } from "./machines.ts";

// A fake worker: what reaches it, and a terminal socket that echoes until told to close.
const seen: { origin?: string; cookie?: string }[] = [];
const updates: { auth?: string; version: string; bundle: string }[] = [];
const worker = new Hono()
  .get("/api/health", (c) => c.json({ ok: true, version: "0000000000000001" }))
  .post("/api/system/update", async (c) => {
    const body = (await c.req.json()) as { version: string; bundle: string };
    updates.push({ auth: c.req.header("authorization"), ...body });
    return c.json({ restarting: "server", pid: 7, version: body.version }, 202);
  })
  .on(["GET", "POST"], "/api/echo/*", async (c) => {
    seen.push({ origin: c.req.header("origin"), cookie: c.req.header("cookie") });
    return c.json({
      method: c.req.method,
      path: c.req.path,
      query: c.req.query("q") ?? null,
      body: c.req.method === "POST" ? await c.req.json() : null,
    });
  })
  .get("/api/missing", (c) => c.json({ error: "not_found" }, 404))
  .get(
    "/api/terminals/:id/ws",
    upgradeWebSocket((c) => {
      const origin = c.req.header("origin");
      return {
        onMessage(event, ws) {
          if (event.data === "close") ws.close(4409, "busy");
          else ws.send(`${origin} ${c.req.param("id")} ${event.data}`);
        },
      };
    }),
  );
const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: worker.fetch, websocket });
const machine = { id: "win", label: "PC", origin: `http://127.0.0.1:${upstream.port}` };
// A port nothing listens on: bound once, then released.
const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const deadPort = closed.port;
closed.stop(true);
const dead = { id: "off", label: "Portátil", origin: `http://127.0.0.1:${deadPort}` };

// A worker that takes the connection and never answers it: a path that hangs.
const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const mute = { id: "mute", label: "Mudo", origin: `http://127.0.0.1:${silent.port}` };

let hubPort = 0;
const hub = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  websocket,
  fetch: (req, srv) => app.fetch(req, srv),
});
hubPort = hub.port ?? 0;
const local = `http://localhost:${hubPort}`;
const kept = new Map<string, string>();
const asked: string[] = [];
const app = new Hono()
  .route("/api/mute", machineRoutes([mute], new Set([local]), { openMs: 200 }))
  .route(
    "/api/seen",
    machineRoutes([machine, dead], new Set([local]), {
      peer: async (host) => {
        asked.push(host);
        return { online: true, lastSeen: null };
      },
    }),
  )
  .route("/api/machines", machineRoutes([machine, dead], new Set([local])))
  .route(
    "/api/hub",
    machineRoutes([machine], new Set([local]), {
      code: { version: async () => "0000000000000002", bundle: async () => new Uint8Array([1, 2]) },
      tokens: {
        get: async (id) => kept.get(id) ?? null,
        set: async (id, t) => void kept.set(id, t),
      },
    }),
  );
afterAll(() => {
  silent.stop(true);
  hub.stop(true);
  upstream.stop(true);
});

test("a hub path maps to the worker's /api and never leaves it", () => {
  expect(upstreamUrl(machine, "/terminals", "?a=1")?.href).toBe(
    `${machine.origin}/api/terminals?a=1`,
  );
  expect(upstreamUrl(machine, "/../../etc", "")).toBeNull();
  // A doubled slash stays a path on the worker, never another host.
  expect(upstreamUrl(machine, "//evil.example/api/x", "")?.origin).toBe(machine.origin);
  expect(upstreamUrl(machine, "terminals", "")).toBeNull();
});

test("only codes a server may send pass on; the rest become a retry", () => {
  expect([1000, 1001, 4409, 4503].map(relayCode)).toEqual([1000, 1001, 4409, 4503]);
  expect([1005, 1006, 1011].map(relayCode)).toEqual([4503, 4503, 4503]);
});

test("the proxy sends the worker's Origin, keeps path, query and body, and drops cookies", async () => {
  const get = await fetch(`${local}/api/machines/win/echo/a?q=1`, {
    headers: { origin: local, cookie: "secret=1" },
  });
  expect(await get.json()).toEqual({ method: "GET", path: "/api/echo/a", query: "1", body: null });
  const post = await fetch(`${local}/api/machines/win/echo/b`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: local },
    body: JSON.stringify({ x: 1 }),
  });
  expect(await post.json()).toEqual({
    method: "POST",
    path: "/api/echo/b",
    query: null,
    body: { x: 1 },
  });
  expect(seen).toEqual([
    { origin: machine.origin, cookie: undefined },
    { origin: machine.origin, cookie: undefined },
  ]);
});

test("the worker's errors pass through; an unknown or unreachable machine is an error", async () => {
  const missing = await fetch(`${local}/api/machines/win/missing`);
  expect([missing.status, await missing.json()]).toEqual([404, { error: "not_found" }]);
  const unknown = await fetch(`${local}/api/machines/nope/terminals`);
  expect([unknown.status, await unknown.json()]).toEqual([404, { error: "unknown_machine" }]);
  const down = await fetch(`${local}/api/machines/off/terminals`);
  expect(down.status).toBe(502);
  expect(((await down.json()) as { error: string }).error).toBe("machine_unreachable");
});

test("the machine list says which worker answers", async () => {
  const body = (await (await fetch(`${local}/api/machines`)).json()) as {
    machines: { id: string; online: boolean; version: string | null }[];
  };
  expect(body.machines.map((m) => [m.id, m.online, m.version])).toEqual([
    ["win", true, "0000000000000001"],
    ["off", false, null],
  ]);
});

test("only a worker that does not answer is looked up in Tailscale, and says which side failed", async () => {
  const body = (await (await fetch(`${local}/api/seen`)).json()) as {
    machines: { id: string; error: string | null; tailscale: unknown }[];
  };
  expect(asked).toEqual(["127.0.0.1"]);
  expect(body.machines.map((m) => [m.id, m.tailscale])).toEqual([
    ["win", null],
    ["off", { online: true, lastSeen: null }],
  ]);
  expect(body.machines[1]?.error).toContain("no publica su ruta Serve");
});

test("an offline worker says what to do: Serve without a server, or no Serve at all", () => {
  expect(offlineReason(null, "x", { online: false, lastSeen: "2026-10-11T00:31:00Z" })).toBe(
    "apagada o fuera de Tailscale (vista por última vez el 11 oct, 00:31): enciéndela; el worker arranca al iniciar sesión",
  );
  // An HTTP answer comes from the worker's side, whatever Tailscale says.
  expect(offlineReason(502, "", { online: true, lastSeen: null })).toContain("su servidor no");
  expect(offlineReason(502, "")).toContain("espera inicio de sesión");
  expect(offlineReason(404, "")).toBe("HTTP 404");
  expect(offlineReason(null, "The operation timed out.")).toBe(
    "sin respuesta (The operation timed out.): la máquina está apagada o no publica Tailscale Serve; arranca el worker en ella",
  );
});

test("an update needs the worker's pairing token, then carries the hub's code with it", async () => {
  const send = () =>
    fetch(`${local}/api/hub/win/update`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: local },
      body: "{}",
    });
  const unpaired = await send();
  expect([unpaired.status, ((await unpaired.json()) as { error: string }).error]).toEqual([
    409,
    "unpaired",
  ]);
  const bad = await fetch(`${local}/api/hub/win/token`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "short" }),
  });
  expect(bad.status).toBe(400);
  const token = "a".repeat(43);
  const ok = await fetch(`${local}/api/hub/win/token`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  expect(ok.status).toBe(200);
  const sent = await send();
  expect([sent.status, await sent.json()]).toEqual([
    202,
    { restarting: "server", pid: 7, version: "0000000000000002" },
  ]);
  expect(updates).toEqual([
    { auth: `Bearer ${token}`, version: "0000000000000002", bundle: "AQI=" },
  ]);
});

test("a terminal socket is bridged: queued first frame, worker Origin, close code relayed", async () => {
  const ws = new WebSocket(`ws://localhost:${hubPort}/api/machines/win/terminals/t1/ws`, {
    headers: { origin: local },
  } as unknown as string[]);
  const messages: string[] = [];
  const closed = new Promise<number>((resolve) => {
    ws.onclose = (e) => resolve(e.code);
  });
  // Sent the moment the hub's socket opens, before the worker's is up: it must be queued.
  ws.onopen = () => ws.send("auth");
  ws.onmessage = (e) => {
    messages.push(String(e.data));
    ws.send("close");
  };
  expect(await closed).toBe(4409);
  expect(messages).toEqual([`${machine.origin} t1 auth`]);
});

test("a socket from a foreign Origin never reaches the worker", async () => {
  const ws = new WebSocket(`ws://localhost:${hubPort}/api/machines/win/terminals/t1/ws`, {
    headers: { origin: "http://evil.example" },
  } as unknown as string[]);
  const code = await new Promise<number>((resolve) => {
    ws.onclose = (e) => resolve(e.code);
  });
  expect(code).toBe(1002);
});

test("a worker socket that never opens is given up with a code the window retries", async () => {
  const ws = new WebSocket(`ws://localhost:${hubPort}/api/mute/mute/terminals/t1/ws`, {
    headers: { origin: local },
  } as unknown as string[]);
  const code = await new Promise<number>((resolve) => {
    ws.onclose = (e) => resolve(e.code);
  });
  expect(code).toBe(4503);
});

test("a worker that does not answer is held down, then let through one request at a time", async () => {
  let at = 0;
  const asked: string[] = [];
  let up = false;
  const pc = { id: "pc", label: "PC", origin: "http://pc.invalid" };
  const routes = new Hono().route(
    "/api/machines",
    machineRoutes([pc], new Set([local]), {
      health: breaker(() => at),
      get: async (url) => {
        asked.push(new URL(String(url)).pathname);
        if (up) return new Response("{}", { headers: { "x-request-id": "w1" } });
        throw new Error("Unable to connect");
      },
    }),
  );
  const ask = async () => (await routes.request("/api/machines/pc/ai")).status;
  expect(await ask()).toBe(502);
  // Held: answered at once, the worker is not asked.
  expect(await ask()).toBe(503);
  expect(asked).toEqual(["/api/ai"]);
  // The try asks the health first; without an answer the request is never sent.
  at = 2_000;
  expect(await ask()).toBe(503);
  expect(asked).toEqual(["/api/ai", "/api/health"]);
  // The wait doubled: still held at 3 s, let through at 6 s.
  at = 3_000;
  expect(await ask()).toBe(503);
  up = true;
  at = 6_000;
  expect(await ask()).toBe(200);
  expect(await ask()).toBe(200);
  expect(asked).toEqual(["/api/ai", "/api/health", "/api/health", "/api/ai", "/api/ai"]);
});

test("Tailscale Serve's 502 without the worker's request ID is the machine down", async () => {
  const pc = { id: "pc", label: "PC", origin: "http://pc.invalid" };
  const routes = new Hono().route(
    "/api/machines",
    machineRoutes([pc], new Set([local]), {
      health: breaker(() => 0),
      get: async () => new Response("Bad Gateway", { status: 502 }),
    }),
  );
  const first = await routes.request("/api/machines/pc/ai");
  expect([first.status, ((await first.json()) as { error: string }).error]).toEqual([
    502,
    "machine_unreachable",
  ]);
  const held = await routes.request("/api/machines/pc/ai");
  expect([held.status, held.headers.get("retry-after")]).toEqual([503, "2"]);
  // A held answer keeps what to do about it, not only that the machine is down.
  expect(((await held.json()) as { detail: string }).detail).toContain("Tailscale Serve responde");
});
