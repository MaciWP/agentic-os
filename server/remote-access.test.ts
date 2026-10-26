import { expect, test } from "bun:test";
import { Hono } from "hono";
import { RemoteConfig } from "../shared/access.ts";
import { remoteGuard } from "./remote-access.ts";

test("remote identity gates every resource and exact origins gate writes and sockets", async () => {
  const cfg = RemoteConfig.parse({
    enabled: true,
    origin: "https://host.example.ts.net",
    login: "owner@example.com",
  });
  const app = new Hono().use("*", remoteGuard(cfg)).all("*", (c) => c.text("allowed"));
  const headers = { host: "host.example.ts.net", "tailscale-user-login": cfg.login ?? "" };
  for (const path of ["/", "/api/events", "/api/terminals/a/ws", "/assets/app.js"]) {
    expect((await app.request(path, { headers })).status).toBe(200);
    expect(
      (
        await app.request(path, {
          headers: { ...headers, "tailscale-user-login": "other@example.com" },
        })
      ).status,
    ).toBe(403);
    expect((await app.request(path, { headers: { host: headers.host } })).status).toBe(403);
  }
  expect((await app.request("/api/x", { method: "POST", headers })).status).toBe(403);
  expect(
    (
      await app.request("/api/x", {
        method: "POST",
        headers: { ...headers, origin: cfg.origin ?? "" },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request("/api/x", {
        headers: { ...headers, upgrade: "websocket", origin: "https://evil.example" },
      })
    ).status,
  ).toBe(403);
  expect(
    (await app.request("/", { headers: { ...headers, "tailscale-funnel-request": "?1" } })).status,
  ).toBe(403);
});

test("remote configuration refuses non-Tailscale origins and incomplete identity", () => {
  for (const origin of [
    "http://host.test.ts.net",
    "https://host.test.ts.net/path",
    "https://host.test.ts.net:4319",
    "https://host.test.ts.net.evil.example",
    "https://user:password@host.test.ts.net",
  ])
    expect(
      RemoteConfig.safeParse({ enabled: true, origin, login: "owner@example.com" }).success,
    ).toBe(false);
  expect(RemoteConfig.safeParse({ enabled: true }).success).toBe(false);
});
