import { afterEach, beforeEach, expect, mock, test } from "bun:test";

// Keychain fake: tests must never touch the real one.
const store = new Map<string, string>();
mock.module("./secrets.ts", () => ({
  getSecret: async (name: string) => store.get(name) ?? null,
  setSecret: async (name: string, value: string) => {
    store.set(name, value);
  },
}));
const { consumeState, createState, oauthTokens, ReconnectError } = await import("./oauth.ts");

const KEY = "atlassian.tokens";
const realFetch = globalThis.fetch;
let posts: Array<{ type: string | null; body: Record<string, string> }> = [];
let reply: Record<string, unknown> = {};

// A public form-encoded client, as Microsoft's is.
const client = oauthTokens({
  provider: "microsoft",
  label: "Microsoft",
  tokenUrl: "https://login.example/token",
  tokensKey: KEY,
  encoding: "form",
  credentials: async () => ({ clientId: "public-id" }),
  reconnect: (reason) => new ReconnectError("microsoft", `Microsoft: ${reason}`),
});

beforeEach(() => {
  store.clear();
  posts = [];
  reply = { access_token: "a1", refresh_token: "r1", expires_in: 3600 };
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const type = new Headers(init.headers).get("content-type");
    posts.push({ type, body: Object.fromEntries(new URLSearchParams(String(init.body))) });
    return Response.json(reply);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("a public client exchanges the code as a form with the PKCE verifier and no secret", async () => {
  await client.exchangeCode("c0", "http://127.0.0.1/cb", "v0");
  expect(posts[0]?.type).toBe("application/x-www-form-urlencoded");
  expect(posts[0]?.body).toEqual({
    grant_type: "authorization_code",
    client_id: "public-id",
    code: "c0",
    redirect_uri: "http://127.0.0.1/cb",
    code_verifier: "v0",
  });
  expect(JSON.parse(store.get(KEY) ?? "{}").refreshToken).toBe("r1");
});

test("a refresh without a new refresh token keeps the stored one", async () => {
  store.set(
    KEY,
    JSON.stringify({ accessToken: "old", refreshToken: "r0", expiresAt: 0, scope: "" }),
  );
  reply = { access_token: "a2", expires_in: 3600 };
  expect(await client.getAccessToken()).toBe("a2");
  expect(posts[0]?.body.refresh_token).toBe("r0");
  expect(JSON.parse(store.get(KEY) ?? "{}").refreshToken).toBe("r0");
});

test("a code exchange without a refresh token asks for reconnection", async () => {
  reply = { access_token: "a1", expires_in: 3600 };
  await expect(client.exchangeCode("c0", "http://127.0.0.1/cb")).rejects.toBeInstanceOf(
    ReconnectError,
  );
  expect(store.has(KEY)).toBe(false);
});

test("state carries the PKCE verifier to the callback", () => {
  const s = createState("/hoy", Date.now(), "v0");
  expect(consumeState(s, s)).toEqual({ ok: true, returnTo: "/hoy", verifier: "v0" });
});
