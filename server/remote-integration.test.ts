import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { createApp } from "./app.ts";
import { ConfigSchema } from "./config.ts";
import { openDb } from "./db.ts";
import { TerminalManager } from "./features/terminals/pty.ts";
import { AttachTokens } from "./features/terminals/ws-guard.ts";
import { remoteGuard } from "./remote-access.ts";

test("remote ingress preserves authentication through API and real WebSocket upgrades", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aos-remote-"));
  const db = openDb(":memory:");
  const origin = "https://host.test.ts.net";
  const config = ConfigSchema.parse({
    providers: { github: false },
    remote: { enabled: true, origin, login: "owner@example.com" },
    terminals: { shell: "/bin/sh" },
  });
  const terminals = new TerminalManager(config, db, async () => ({
    PATH: "/usr/bin:/bin",
    TERM: "xterm-256color",
  }));
  const api = createApp({
    config,
    db,
    terminals,
    tokens: new AttachTokens(),
    memoryRoots: { home: dir, dataDir: dir, repos: [] },
    pastesDir: join(dir, "pastes"),
    sessions: { home: dir, procs: async () => new Map() },
  });
  const ingress = new Hono()
    .use("*", remoteGuard(config.remote))
    .all("*", (c) => api.fetch(c.req.raw, c.env));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: ingress.fetch, websocket });
  const base = `http://127.0.0.1:${server.port}`;
  const headers = {
    host: "host.test.ts.net",
    origin,
    "tailscale-user-login": "owner@example.com",
    "content-type": "application/json",
  };
  let socket: WebSocket | undefined;
  try {
    expect(await fetch(`${base}/api/access`, { headers }).then((r) => r.json())).toEqual({
      remote: true,
      desktop: false,
    });
    // What needs the Mac's own screen or desktop stays there.
    for (const path of ["/api/images/capture", "/api/terminals/example/open-folder"])
      expect((await fetch(`${base}${path}`, { headers, method: "POST", body: "{}" })).status).toBe(
        409,
      );
    expect((await fetch(`${base}/auth/atlassian/start`, { headers })).status).toBe(409);
    // The folder picker and «Añadir repo» work remotely: the request reaches the route.
    for (const path of ["/api/files/folders?path=%2F", "/api/files/places"])
      expect((await fetch(`${base}${path}`, { headers })).status).toBe(200);
    const addRepo = await fetch(`${base}/api/projects/repos`, {
      headers,
      method: "POST",
      body: "{}",
    });
    expect(addRepo.status).toBe(400);
    // A restart is how a device away from the Mac loads new code: it reaches the route, which
    // refuses here only because this app has no restarter.
    const restart = await fetch(`${base}/api/system/restart`, {
      headers,
      method: "POST",
      body: JSON.stringify({ scope: "all" }),
    });
    expect(await restart.json()).toEqual({
      error: "restart_refused",
      detail: "este servidor no puede reiniciarse",
    });
    const terminal = await terminals.create({ harness: "shell", location: "app" });
    const tokenResponse = await fetch(`${base}/api/terminals/${terminal.id}/attach`, {
      headers,
      method: "POST",
      body: "{}",
    });
    expect(tokenResponse.status).toBe(200);
    const { token } = await tokenResponse.json();
    const frame = await new Promise<{ type: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("remote socket timed out")), 4000);
      socket = new (
        WebSocket as unknown as {
          new (url: string, options: { headers: Record<string, string> }): WebSocket;
        }
      )(`ws://127.0.0.1:${server.port}/api/terminals/${terminal.id}/ws`, { headers });
      socket.onopen = () => socket?.send(JSON.stringify({ type: "auth", token, take: false }));
      socket.onmessage = (e) => {
        if (typeof e.data === "string") {
          clearTimeout(timeout);
          resolve(JSON.parse(e.data));
        }
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("remote upgrade failed"));
      };
    });
    expect(frame.type).toBe("snapshot");
    expect(
      (
        await fetch(`${base}/api/health`, {
          headers: { ...headers, "tailscale-user-login": "stranger@example.com" },
        })
      ).status,
    ).toBe(403);
  } finally {
    socket?.close();
    await terminals.stopAll();
    api.dispose();
    await server.stop(true);
    db.close();
    rmSync(dir, { recursive: true });
  }
});
