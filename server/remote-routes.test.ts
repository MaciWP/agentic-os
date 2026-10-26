import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createApp } from "./app.ts";
import { ConfigSchema } from "./config.ts";
import { openDb } from "./db.ts";
import { TerminalManager } from "./features/terminals/pty.ts";
import { AttachTokens } from "./features/terminals/ws-guard.ts";
import { remoteGuard } from "./remote-access.ts";
import { ROUTES, remoteAllowlist } from "./remote-routes.ts";
import { withSpa } from "./static.ts";

const dir = mkdtempSync(join(tmpdir(), "aos-remote-routes-"));
mkdirSync(join(dir, "dist", "assets"), { recursive: true });
writeFileSync(join(dir, "dist", "index.html"), "<!doctype html><title>x</title>");
writeFileSync(join(dir, "dist", "assets", "app-AbCd1234.js"), "console.log(1);");
const db = openDb(":memory:");
const origin = "https://host.test.ts.net";
const config = ConfigSchema.parse({
  providers: { github: false },
  remote: { enabled: true, origin, login: "owner@example.com" },
  terminals: { shell: "/bin/sh" },
});
const api = createApp({
  config,
  db,
  terminals: new TerminalManager(config, db, async () => ({ PATH: "/usr/bin:/bin" })),
  tokens: new AttachTokens(),
  memoryRoots: { home: dir, dataDir: dir, repos: [] },
  pastesDir: join(dir, "pastes"),
  sessions: { home: dir, procs: async () => new Map() },
});
afterAll(() => {
  api.dispose();
  db.close();
  rmSync(dir, { recursive: true });
});
const cfg = config.remote;
const remote = {
  host: "host.test.ts.net",
  origin,
  "tailscale-user-login": "owner@example.com",
  "content-type": "application/json",
};
const live = new Set(
  api.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`),
);

test("every API route says whether it is served remotely, and every entry is a live route", () => {
  expect([...live].filter((key) => !(key in ROUTES))).toEqual([]);
  expect(Object.keys(ROUTES).filter((key) => !live.has(key))).toEqual([]);
});

test("every route sits under /api or /auth, so the local guard checks every write", () => {
  expect([...live].filter((key) => !/^[A-Z]+ \/(api|auth)\//.test(key))).toEqual([]);
});

test("through the production stack, desktop routes refuse remotely and the rest is served", async () => {
  // The same layers as server/index.ts: the ingress, then the API, its 404, and the SPA.
  const spa = withSpa(api, join(dir, "dist"));
  const ingress = new Hono()
    .use("*", remoteGuard(cfg))
    .all("*", (c) => spa.fetch(c.req.raw, c.env));
  const send = (method: string, path: string) =>
    ingress.request(path, { method, headers: remote, body: method === "GET" ? undefined : "{}" });
  expect(await (await send("GET", "/api/access")).json()).toEqual({ remote: true, desktop: false });
  expect((await send("GET", "/api/health")).status).toBe(200);
  expect((await send("GET", "/")).status).toBe(200);
  expect((await send("GET", "/assets/app-AbCd1234.js")).status).toBe(200);
  expect((await send("GET", "/api/nope")).status).toBe(404);
  const desktop = Object.entries(ROUTES).filter(([, reach]) => reach === "desktop");
  expect(desktop.length).toBeGreaterThan(0);
  for (const [key] of desktop) {
    const [method = "", path = ""] = key.split(" ");
    const res = await send(method, path.replaceAll(/:\w+/g, "x"));
    expect([key, res.status, (await res.json()).error]).toEqual([
      key,
      409,
      "local_desktop_required",
    ]);
  }
});

test("the answering route decides, and an unclassified route is refused only remotely", async () => {
  const routes = { "GET /api/t/team": "desktop", "GET /api/t/:key": "remote" } as const;
  const tickets = new Hono().get("/team", (c) => c.text("team")).get("/:key", (c) => c.text("key"));
  const build = (front: Hono) =>
    front
      .use("*", remoteAllowlist(routes))
      .route("/api/t", tickets)
      .get("/api/u", (c) => c.text("u"));
  const viaIngress = build(new Hono().use("*", remoteGuard(cfg)));
  const headers = { host: remote.host, "tailscale-user-login": remote["tailscale-user-login"] };
  expect((await viaIngress.request("/api/t/team", { headers })).status).toBe(409);
  expect(await (await viaIngress.request("/api/t/ABC-1", { headers })).text()).toBe("key");
  expect(await (await viaIngress.request("/api/u", { headers })).json()).toEqual({
    error: "remote_not_allowed",
  });
  const local = build(new Hono());
  expect(await (await local.request("/api/t/team")).text()).toBe("team");
  expect(await (await local.request("/api/u")).text()).toBe("u");
});
