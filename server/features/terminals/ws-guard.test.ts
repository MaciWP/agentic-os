import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { remoteGuard } from "../../remote-access.ts";
import { allowedOrigins, wsGuard } from "./ws-guard.ts";

const REMOTE = "https://mac.tailnet.ts.net";
const LOGIN = "me@example.com";
const origins = allowedOrigins(4317, 5173, true, REMOTE);
const ok = (app: Hono) => app.get("/ws", (c) => c.text("upgraded"));
// The server's own port: no ingress mark on anything that reaches it.
const direct = ok(new Hono().use(wsGuard(origins)));
// The remote ingress: remoteGuard marks what Tailscale authenticated.
const ingress = ok(
  new Hono()
    .use(remoteGuard({ enabled: true, port: 4319, origin: REMOTE, login: LOGIN }))
    .use(wsGuard(origins)),
);
const upgrade = (host: string, origin: string, more: Record<string, string> = {}) =>
  new Request(`http://${host}/ws`, { headers: { host, origin, upgrade: "websocket", ...more } });

describe("wsGuard and the ingress mark", () => {
  test("the remote name is refused on a socket that did not come through the ingress", async () => {
    const res = await direct.fetch(upgrade(new URL(REMOTE).host, REMOTE));
    expect(res.status).toBe(403);
  });

  test("the remote name is accepted on a socket the ingress authenticated", async () => {
    const res = await ingress.fetch(
      upgrade(new URL(REMOTE).host, REMOTE, { "tailscale-user-login": LOGIN }),
    );
    expect(res.status).toBe(200);
  });

  test("a local socket passes; a local name with the remote origin does not", async () => {
    expect((await direct.fetch(upgrade("localhost:4317", "http://localhost:4317"))).status).toBe(
      200,
    );
    expect((await direct.fetch(upgrade("localhost:4317", REMOTE))).status).toBe(403);
  });
});
