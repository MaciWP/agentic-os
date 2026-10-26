import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

// Keychain fake: tests must never touch the real one.
const store = new Map<string, string>();
mock.module("../../secrets.ts", () => ({
  getSecret: async (name: string) => store.get(name) ?? null,
  setSecret: async (name: string, value: string) => {
    store.set(name, value);
  },
}));
const { createApp } = await import("../../app.ts");
const { ConfigSchema } = await import("../../config.ts");
const { openDb } = await import("../../db.ts");
const { ProviderError } = await import("../../provider-error.ts");
const { TerminalManager } = await import("../terminals/pty.ts");
const { AttachTokens } = await import("../terminals/ws-guard.ts");
const { jiraClient } = await import("./client.ts");
const { fetchMyself, listResources, ReconnectRequired, saveConnection } = await import(
  "./oauth.ts"
);

// Words only Atlassian's answer holds: they must never reach a client.
const MARKER = "UPSTREAM-BODY-7f3a";

// Atlassian on loopback: api.atlassian.com and auth.atlassian.com both land here.
let handle: (req: Request) => Response | Promise<Response> = () => new Response("{}");
const atlassian = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => handle(req) });
const realFetch = globalThis.fetch;
let reachable = true;

const config = ConfigSchema.parse({
  port: 4317,
  terminals: { shell: "/bin/sh" },
  jira: { site: "https://example.atlassian.net", project: "ABC" },
});
const db = openDb(":memory:");
saveConnection(db, {
  accountId: "u1",
  displayName: "Someone",
  siteUrl: "https://example.atlassian.net",
  cloudId: "cloud",
  scopes: "",
});
const app = createApp({
  config,
  db,
  terminals: new TerminalManager(config, db, () => Promise.resolve({})),
  tokens: new AttachTokens(),
});
const tickets = async () => {
  const res = await app.request("/api/tickets?fresh=1", { headers: { host: "127.0.0.1:4317" } });
  return { status: res.status, text: await res.text() };
};

const tokens = (expiresAt: number) =>
  JSON.stringify({ accessToken: "a", refreshToken: "r", expiresAt, scope: "" });

beforeEach(() => {
  store.clear();
  store.set("atlassian.client_id", "id");
  store.set("atlassian.client_secret", "secret");
  store.set("atlassian.tokens", tokens(Date.now() + 3600_000));
  reachable = true;
  globalThis.fetch = ((url: string, init?: RequestInit) =>
    realFetch(
      String(url).replace(
        /^https:\/\/(api|auth)\.atlassian\.com/,
        reachable ? `http://127.0.0.1:${atlassian.port}` : "http://127.0.0.1:1",
      ),
      init,
    )) as typeof fetch;
  // The server logs Atlassian's body; the test reads only what the client gets.
  spyOn(console, "error").mockImplementation(() => {});
  spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  globalThis.fetch = realFetch;
  mock.restore();
});
afterAll(() => atlassian.stop(true));

describe("every Jira failure is a ProviderError", () => {
  test("Jira unreachable", async () => {
    reachable = false;
    const err = await jiraClient(db)
      .request(ConfigSchema, "/rest/api/3/myself")
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(503);
  });

  test("the token endpoint unreachable", async () => {
    store.set("atlassian.tokens", tokens(Date.now() - 1));
    reachable = false;
    const r = await tickets();
    expect(r.status).toBe(502);
    expect(JSON.parse(r.text)).toMatchObject({ error: "provider_error", provider: "jira" });
  });

  test("the token endpoint failing", async () => {
    store.set("atlassian.tokens", tokens(Date.now() - 1));
    handle = () => new Response(`{"error":"server_error","detail":"${MARKER}"}`, { status: 500 });
    const r = await tickets();
    expect(r.status).toBe(502);
    expect(JSON.parse(r.text)).toMatchObject({ error: "provider_error", status: 500 });
    expect(r.text).not.toContain(MARKER);
  });

  test("a refused grant asks for a reconnect, in the server's own words", async () => {
    store.set("atlassian.tokens", tokens(Date.now() - 1));
    handle = () => new Response(`{"error":"invalid_grant","hint":"${MARKER}"}`, { status: 403 });
    const r = await tickets();
    expect(r.status).toBe(401);
    expect(JSON.parse(r.text)).toMatchObject({ error: "reconnect_required" });
    expect(r.text).not.toContain(MARKER);
    expect(new ReconnectRequired("x")).toBeInstanceOf(ProviderError);
  });

  test("accessible-resources failing or sending no JSON", async () => {
    handle = () => new Response(MARKER, { status: 500 });
    const failed = await listResources("a").catch((e) => e);
    expect(failed).toBeInstanceOf(ProviderError);
    expect(failed.message).not.toContain(MARKER);
    handle = () => new Response(MARKER, { status: 200 });
    expect(await listResources("a").catch((e) => e)).toBeInstanceOf(ProviderError);
  });

  test("the OAuth callback's /myself unreachable, failing, not JSON or reshaped", async () => {
    const answers: Array<() => Response> = [
      () => new Response(MARKER, { status: 500 }),
      () => new Response(MARKER, { status: 200 }),
      () => Response.json({ [MARKER]: true }),
    ];
    for (const answer of answers) {
      handle = answer;
      const failed = await fetchMyself("a", "cloud").catch((e) => e);
      expect(failed).toBeInstanceOf(ProviderError);
      expect(failed.message).not.toContain(MARKER);
    }
    reachable = false;
    expect(await fetchMyself("a", "cloud").catch((e) => e)).toBeInstanceOf(ProviderError);
    reachable = true;
    handle = () => Response.json({ accountId: "u1", displayName: "Someone" });
    expect(await fetchMyself("a", "cloud")).toEqual({ accountId: "u1", displayName: "Someone" });
  });
});

test("no Jira body reaches the client", async () => {
  handle = () => new Response(`{"errorMessages":["${MARKER}"]}`, { status: 500 });
  const r = await tickets();
  expect(r.status).toBe(502);
  expect(JSON.parse(r.text)).toMatchObject({ error: "provider_error", status: 500 });
  expect(r.text).not.toContain(MARKER);
});
