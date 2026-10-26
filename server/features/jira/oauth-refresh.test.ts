import { afterEach, beforeEach, expect, mock, test } from "bun:test";

// Keychain fake: tests must never touch the real one.
const store = new Map<string, string>();
let beforeRead: ((name: string) => Promise<void>) | null = null;
mock.module("../../secrets.ts", () => ({
  getSecret: async (name: string) => {
    const value = store.get(name) ?? null;
    if (beforeRead) await beforeRead(name);
    return value;
  },
  setSecret: async (name: string, value: string) => {
    store.set(name, value);
  },
}));
const { getAccessToken, ReconnectRequired } = await import("./oauth.ts");

const realFetch = globalThis.fetch;
let posts: Array<Record<string, string>> = [];
let rotation = 0;

function bundle(access: string, refresh: string, expiresAt: number) {
  return JSON.stringify({ accessToken: access, refreshToken: refresh, expiresAt, scope: "" });
}

beforeEach(() => {
  store.clear();
  store.set("atlassian.client_id", "id");
  store.set("atlassian.client_secret", "secret");
  store.set("atlassian.tokens", bundle("old", "r0", Date.now() - 1));
  posts = [];
  rotation = 0;
  beforeRead = null;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    posts.push(body);
    await Bun.sleep(5);
    if (body.refresh_token !== `r${rotation}`) {
      return new Response('{"error":"invalid_grant"}', { status: 403 });
    }
    rotation += 1;
    return Response.json({
      access_token: `a${rotation}`,
      refresh_token: `r${rotation}`,
      expires_in: 3600,
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("concurrent callers share one refresh and get the rotated token", async () => {
  const tokens = await Promise.all(Array.from({ length: 5 }, () => getAccessToken()));
  expect(tokens).toEqual(["a1", "a1", "a1", "a1", "a1"]);
  expect(posts).toHaveLength(1);
  expect(JSON.parse(store.get("atlassian.tokens") ?? "{}").refreshToken).toBe("r1");
});

test("a caller holding a stale read does not spend the rotated refresh token", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  let first = true;
  beforeRead = async (name) => {
    if (name === "atlassian.tokens" && first) {
      first = false;
      await held;
    }
  };
  const stale = getAccessToken(); // reads r0, then waits
  await Bun.sleep(1);
  expect(await getAccessToken()).toBe("a1"); // full refresh r0 -> r1 meanwhile
  release();
  expect(await stale).toBe("a1");
  expect(posts).toHaveLength(1);
});

test("a rejected refresh token asks for reconnection", async () => {
  store.set("atlassian.tokens", bundle("old", "revoked", Date.now() - 1));
  await expect(getAccessToken()).rejects.toBeInstanceOf(ReconnectRequired);
});

test("no stored tokens asks for reconnection", async () => {
  store.delete("atlassian.tokens");
  await expect(getAccessToken()).rejects.toBeInstanceOf(ReconnectRequired);
});
