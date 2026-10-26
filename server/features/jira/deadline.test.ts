import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";

// Keychain fake: tests must never touch the real one.
const store = new Map<string, string>();
mock.module("../../secrets.ts", () => ({
  getSecret: async (name: string) => store.get(name) ?? null,
  setSecret: async (name: string, value: string) => {
    store.set(name, value);
  },
}));
const { jiraClient } = await import("./client.ts");
const { ProviderError } = await import("../../provider-error.ts");
const { saveConnection } = await import("./oauth.ts");
const { searchAllIssues } = await import("./issues.ts");
const { openDb } = await import("../../db.ts");

// A stand-in for Jira on loopback. fetch is pointed at it, so Bun's own abort path runs:
// nothing here rejects with the signal's reason by hand.
let handle: (req: Request) => Response | Promise<Response> = () => new Response("{}");
const jira = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => handle(req) });
const realFetch = globalThis.fetch;
const jiraConfig = {
  site: "https://example.atlassian.net",
  project: "ABC",
  callbackUrl: "http://localhost:4317/auth/atlassian/callback",
  fields: {},
};

const db = openDb(":memory:");
saveConnection(db, {
  accountId: "u1",
  displayName: "Someone",
  siteUrl: jiraConfig.site,
  cloudId: "cloud",
  scopes: "",
});
const client = jiraClient(db);

beforeEach(() => {
  store.set(
    "atlassian.tokens",
    JSON.stringify({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: Date.now() + 3600_000,
      scope: "",
    }),
  );
  globalThis.fetch = ((url: string, init?: RequestInit) =>
    realFetch(
      String(url).replace("https://api.atlassian.com", `http://127.0.0.1:${jira.port}`),
      init,
    )) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
afterAll(() => jira.stop(true));

const page = async (body: unknown, ms: number) => {
  await Bun.sleep(ms);
  return Response.json(body);
};

async function expectTimeout(run: Promise<unknown>) {
  const t0 = performance.now();
  const err = await run.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(ProviderError);
  expect(err).toMatchObject({ provider: "jira", status: 504 });
  expect(performance.now() - t0).toBeLessThan(1000);
}

test("one deadline covers every page: two pages that each fit end as a 504 together", async () => {
  let n = 0;
  handle = () =>
    n++ === 0
      ? page({ issues: [], nextPageToken: "p2" }, 60)
      : page({ issues: [], isLast: true }, 60);
  await expectTimeout(
    searchAllIssues(client, jiraConfig, "jql", { signal: AbortSignal.timeout(100) }),
  );
  n = 0;
  expect(
    await searchAllIssues(client, jiraConfig, "jql", { signal: AbortSignal.timeout(500) }),
  ).toEqual([]);
});

test("a Jira that never sends its headers is a 504", async () => {
  handle = () => new Promise(() => {});
  await expectTimeout(
    searchAllIssues(client, jiraConfig, "jql", { signal: AbortSignal.timeout(100) }),
  );
});

test("a body that stalls after the headers is a 504 too", async () => {
  handle = () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"issues":['));
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  await expectTimeout(
    searchAllIssues(client, jiraConfig, "jql", { signal: AbortSignal.timeout(100) }),
  );
});
