import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { RemoteConfig } from "../shared/access.ts";
import { localGuard, servedPorts } from "./local-guard.ts";
import { remoteGuard } from "./remote-access.ts";

const app = new Hono()
  .use("*", localGuard([4317]))
  .get("/x", (c) => c.text("ok"))
  .post("/x", (c) => c.text("ok"));

const call = (method: string, headers: Record<string, string>) =>
  app.request("/x", { method, headers, body: method === "POST" ? "{}" : undefined });

describe("localGuard", () => {
  test("in production the dev origin cannot mutate", async () => {
    const prod = new Hono()
      .use("*", localGuard(servedPorts(4317, 5173, true)))
      .post("/x", (c) => c.text("ok"));
    const res = await prod.request("/x", {
      method: "POST",
      headers: {
        host: "localhost:4317",
        origin: "http://localhost:5173",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(servedPorts(4317, 5173, false)).toEqual([4317, 5173]);
  });
  test("accepts a same-origin JSON POST", async () => {
    const res = await call("POST", {
      host: "localhost:4317",
      origin: "http://localhost:4317",
      "content-type": "application/json",
    });
    expect(res.status).toBe(200);
  });
  test("rejects a foreign Host even on GET (DNS rebinding)", async () => {
    expect((await call("GET", { host: "evil.test:4317" })).status).toBe(403);
  });
  test("takes the app's own name, exactly, and nothing that ends with it", async () => {
    const res = await call("POST", {
      host: "agentic-os.localhost:4317",
      origin: "http://agentic-os.localhost:4317",
      "content-type": "application/json",
    });
    expect(res.status).toBe(200);
    for (const host of ["evil.agentic-os.localhost:4317", "agentic-os.localhost.evil.test:4317"])
      expect((await call("GET", { host })).status).toBe(403);
  });
  test("rejects a cross-site Origin", async () => {
    const res = await call("POST", {
      host: "localhost:4317",
      origin: "http://evil.test",
      "content-type": "application/json",
    });
    expect(res.status).toBe(403);
  });
  test("rejects a POST without Origin", async () => {
    const res = await call("POST", { host: "localhost:4317", "content-type": "application/json" });
    expect(res.status).toBe(403);
  });
  test("rejects a form-encoded POST", async () => {
    const res = await call("POST", {
      host: "127.0.0.1:4317",
      origin: "http://127.0.0.1:4317",
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(res.status).toBe(415);
  });
  test("the remote name passes only requests the remote ingress authenticated", async () => {
    const remote = RemoteConfig.parse({
      enabled: true,
      origin: "https://host.example.ts.net",
      login: "owner@example.com",
    });
    const inner = new Hono()
      .use("*", localGuard([4317], remote.origin))
      .get("/x", (c) => c.text("ok"))
      .post("/x", (c) => c.text("ok"));
    const ingress = new Hono()
      .use("*", remoteGuard(remote))
      .all("*", (c) => inner.fetch(c.req.raw));
    const headers = {
      host: "host.example.ts.net",
      origin: "https://host.example.ts.net",
      "content-type": "application/json",
    };
    // Reaching the local port directly (a Serve route aimed at it, say) carries no identity.
    expect((await inner.request("/x", { headers })).status).toBe(403);
    expect((await inner.request("/x", { method: "POST", headers, body: "{}" })).status).toBe(403);
    const owner = { ...headers, "tailscale-user-login": "owner@example.com" };
    expect((await ingress.request("/x", { headers: owner })).status).toBe(200);
    expect(
      (await ingress.request("/x", { method: "POST", headers: owner, body: "{}" })).status,
    ).toBe(200);
  });
});
