import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileCopy } from "../../json-file.ts";

// Keychain fake: tests must never touch the real one.
const store = new Map<string, string>();
mock.module("../../secrets.ts", () => ({
  getSecret: async (name: string) => store.get(name) ?? null,
  setSecret: async (name: string, value: string) => {
    store.set(name, value);
  },
}));
const { openDb } = await import("../../db.ts");
const { saveConnection } = await import("../../oauth.ts");
const { ProviderError } = await import("../../provider-error.ts");
const {
  addresses,
  dayWindow,
  GmailCopy,
  googleClient,
  overQuota,
  parseDay,
  quota,
  toEvents,
  toProfile,
} = await import("./client.ts");
const { GoogleReconnect } = await import("./oauth.ts");

const realFetch = globalThis.fetch;
let routes: Record<string, unknown> = {};
let calls: string[] = [];

function connected() {
  const db = openDb(":memory:");
  saveConnection(db, "google", { accountId: "me@gmail.com", displayName: "me", scopes: "" });
  return db;
}

const header = (name: string, value: string) => ({ name, value });
const message = (at: number, labels: string[], from: string, snippet = "") => ({
  labelIds: labels,
  internalDate: String(at),
  snippet,
  payload: { headers: [header("Subject", "Hola"), header("From", from)] },
});

beforeEach(() => {
  store.clear();
  const bundle = {
    accessToken: "a",
    refreshToken: "r",
    expiresAt: Date.now() + 3600_000,
    scope: "",
  };
  store.set("google.tokens", JSON.stringify(bundle));
  calls = [];
  routes = {};
  globalThis.fetch = (async (input: string) => {
    const url = new URL(input);
    calls.push(url.pathname);
    const body =
      routes[`${url.pathname}?${url.searchParams.get("q") ?? ""}`] ?? routes[url.pathname];
    if (typeof body === "function") return (body as () => Response)();
    return body === undefined ? new Response("nope", { status: 404 }) : Response.json(body);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("agenda", () => {
  test("asks for the local day and drops cancelled events", async () => {
    routes["/calendar/v3/calendars/primary/events"] = {
      items: [
        {
          id: "e1",
          summary: "Daily",
          htmlLink: "https://cal/e1",
          start: { dateTime: "2026-10-13T09:00:00+02:00" },
          end: { dateTime: "2026-10-13T09:15:00+02:00" },
          hangoutLink: "https://meet/x",
          attendees: [
            { email: "me@gmail.com", self: true },
            { email: "ana@example.test", displayName: "Ana" },
            { email: "luis@example.test" },
          ],
        },
        {
          id: "e2",
          status: "cancelled",
          htmlLink: "https://cal/e2",
          start: { date: "2026-10-13" },
          end: { date: "2026-10-14" },
        },
        {
          id: "e3",
          htmlLink: "https://cal/e3",
          start: { date: "2026-10-13" },
          end: { date: "2026-10-14" },
        },
      ],
    };
    const events = await googleClient(connected()).agenda(new Date(2026, 9, 13, 12));
    expect(events.map((e) => [e.id, e.title, e.allDay, e.meet])).toEqual([
      ["e1", "Daily", false, "https://meet/x"],
      ["e3", null, true, null],
    ]);
    expect(events[0]).toMatchObject({ source: "google", occurrence: null });
    expect(events[0]?.attendees).toEqual(["Ana", "luis@example.test"]);
  });

  test("a day parameter is a real local date or nothing", () => {
    expect(parseDay("2026-10-13")?.getTime()).toBe(new Date(2026, 9, 13).getTime());
    for (const bad of ["2026-02-30", "2026-1-3", "hoy", undefined])
      expect(parseDay(bad)).toBeNull();
  });

  test("the day window runs from local midnight to the next one", () => {
    const { timeMin, timeMax } = dayWindow(new Date(2026, 9, 13, 23, 59));
    expect(new Date(timeMin).getTime()).toBe(new Date(2026, 9, 13).getTime());
    expect(new Date(timeMax).getTime()).toBe(new Date(2026, 9, 14).getTime());
  });

  test("an event without a start is skipped, not invented", () => {
    const raw = { items: [{ id: "x", htmlLink: "l", start: {}, end: {} }] };
    expect(toEvents(raw)).toEqual([]);
  });
});

describe("inbox", () => {
  test("reads each thread's last message, newest first, with labels across the thread", async () => {
    routes["/gmail/v1/users/me/threads"] = {
      threads: [
        { id: "t1", historyId: "1" },
        { id: "t2", historyId: "1" },
      ],
    };
    routes["/gmail/v1/users/me/threads/t1"] = {
      id: "t1",
      messages: [
        message(1_000, ["UNREAD"], "x@y.com"),
        message(5_000, [], '"Ana Pérez" <ana@x.com>', "it&#39;s &amp; ok"),
      ],
    };
    routes["/gmail/v1/users/me/threads/t2"] = {
      id: "t2",
      messages: [message(9_000, ["STARRED"], "bob@x.com")],
    };
    const { threads, total } = await googleClient(connected()).inbox();
    expect(total).toBe(2);
    expect(threads.map((t) => [t.id, t.from, t.unread, t.starred, t.messages])).toEqual([
      ["t2", "bob@x.com", false, true, 1],
      ["t1", "Ana Pérez", true, false, 2],
    ]);
    expect(threads[1]?.snippet).toBe("it's & ok");
    expect(threads[1]?.link).toContain("authuser=me%40gmail.com#inbox/t1");
  });

  test("an empty inbox is an empty list", async () => {
    routes["/gmail/v1/users/me/threads"] = { resultSizeEstimate: 0 };
    expect(await googleClient(connected()).inbox()).toEqual({ threads: [], total: 0 });
  });

  test("a changed thread shape is a provider error, never a partial list", async () => {
    routes["/gmail/v1/users/me/threads"] = { threads: [{ id: "t1", historyId: "1" }] };
    routes["/gmail/v1/users/me/threads/t1"] = { id: "t1", messages: [] };
    await expect(googleClient(connected()).inbox()).rejects.toBeInstanceOf(ProviderError);
  });

  test("reads again only the threads whose history changed", async () => {
    const list = (h2: string) => ({
      threads: [
        { id: "t1", historyId: "1" },
        { id: "t2", historyId: h2 },
      ],
    });
    routes["/gmail/v1/users/me/threads"] = list("1");
    routes["/gmail/v1/users/me/threads/t1"] = {
      id: "t1",
      messages: [message(1_000, [], "a@x.com")],
    };
    routes["/gmail/v1/users/me/threads/t2"] = {
      id: "t2",
      messages: [message(2_000, [], "b@x.com")],
    };
    const client = googleClient(connected());
    await client.inbox();
    calls = [];
    expect((await client.inbox()).threads.length).toBe(2);
    expect(calls).toEqual(["/gmail/v1/users/me/threads"]);
    routes["/gmail/v1/users/me/threads"] = list("2");
    calls = [];
    await client.inbox();
    expect(calls).toEqual(["/gmail/v1/users/me/threads", "/gmail/v1/users/me/threads/t2"]);
  });
});

describe("inbox copy on disk", () => {
  const copyAt = () => join(mkdtempSync(join(tmpdir(), "aos-gmail-")), "inbox-gmail.json");
  const twoThreads = () => {
    routes["/gmail/v1/users/me/threads"] = {
      threads: [
        { id: "t1", historyId: "1" },
        { id: "t2", historyId: "1" },
      ],
    };
    for (const [id, at] of [
      ["t1", 1_000],
      ["t2", 2_000],
    ] as const)
      routes[`/gmail/v1/users/me/threads/${id}`] = { id, messages: [message(at, [], "a@x.com")] };
  };

  test("a restarted client answers its copy and spends only the list when nothing changed", async () => {
    twoThreads();
    const path = copyAt();
    const db = connected();
    const first = await googleClient(db, { copy: fileCopy(path, GmailCopy) }).inbox();
    let units = 0;
    const spend = async (n: number) => {
      units += n;
    };
    const restarted = googleClient(db, { spend, copy: fileCopy(path, GmailCopy) });
    expect(restarted.storedInbox()?.value).toEqual(first);
    calls = [];
    expect(await restarted.inbox()).toEqual(first);
    expect(calls).toEqual(["/gmail/v1/users/me/threads"]);
    expect(units).toBe(10);
  });

  test("another account's copy is never answered nor reused", async () => {
    twoThreads();
    const path = copyAt();
    const other = openDb(":memory:");
    saveConnection(other, "google", { accountId: "other@gmail.com", displayName: "o", scopes: "" });
    await googleClient(other, { copy: fileCopy(path, GmailCopy) }).inbox();
    const mine = googleClient(connected(), { copy: fileCopy(path, GmailCopy) });
    expect(mine.storedInbox()).toBeUndefined();
    calls = [];
    await mine.inbox();
    expect(calls).toHaveLength(3);
  });

  test("a broken copy is no copy", async () => {
    twoThreads();
    const path = copyAt();
    writeFileSync(path, "{ not json");
    const client = googleClient(connected(), { copy: fileCopy(path, GmailCopy) });
    expect(client.storedInbox()).toBeUndefined();
    expect((await client.inbox()).threads).toHaveLength(2);
  });
});

describe("over quota", () => {
  const refused =
    (reason: string, status = 403) =>
    () =>
      Response.json({ error: { code: status, errors: [{ reason }] } }, { status });
  const free = async () => {};

  test("waits and tries again when Gmail says the quota is spent", async () => {
    let n = 0;
    routes["/gmail/v1/users/me/threads/a1"] = () =>
      n++ === 0
        ? refused("userRateLimitExceeded")()
        : Response.json({
            id: "a1",
            messages: [{ id: "m", internalDate: "1", payload: { headers: [] } }],
          });
    const waits: number[] = [];
    const client = googleClient(connected(), {
      spend: free,
      wait: async (ms) => {
        waits.push(ms);
      },
    });
    expect((await client.thread("a1")).id).toBe("a1");
    expect(waits.length).toBe(1);
  });

  test("a refusal for any other reason is not tried again", async () => {
    routes["/gmail/v1/users/me/threads/a1"] = refused("insufficientPermissions");
    const waits: number[] = [];
    const client = googleClient(connected(), {
      spend: free,
      wait: async (ms) => {
        waits.push(ms);
      },
    });
    const err = await client.thread("a1").catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(overQuota(err)).toBe(false);
    expect(waits).toEqual([]);
  });

  test("after the last retry it says the quota is spent, never an empty answer", async () => {
    routes["/gmail/v1/users/me/threads/a1"] = refused("rateLimitExceeded", 429);
    const client = googleClient(connected(), { spend: free, wait: async () => {} });
    const err = await client.thread("a1").catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(429);
    expect(err.message).toContain("quota");
    expect(calls.length).toBe(4);
  });
});

test("without a connection every read asks to connect, before any call", async () => {
  const client = googleClient(openDb(":memory:"));
  await expect(client.agenda()).rejects.toBeInstanceOf(GoogleReconnect);
  await expect(client.inbox()).rejects.toBeInstanceOf(GoogleReconnect);
  await expect(client.thread("a1")).rejects.toBeInstanceOf(GoogleReconnect);
  expect(calls).toEqual([]);
});

describe("thread", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
  const full = (id: string, at: number, payload: object) => ({
    id,
    internalDate: String(at),
    payload,
  });
  const path = "/gmail/v1/users/me/threads/a1";

  test("reads every message's plain part from a nested multipart, with its headers", async () => {
    routes[path] = {
      id: "a1",
      messages: [
        full("m1", 1_000, {
          mimeType: "multipart/mixed",
          headers: [
            header("Subject", "Factura"),
            header("From", "ana@x.com"),
            header("To", "me@gmail.com"),
          ],
          parts: [
            {
              mimeType: "multipart/alternative",
              parts: [
                { mimeType: "text/plain", body: { data: b64("Hola,\r\n¿qué tal?") } },
                { mimeType: "text/html", body: { data: b64("<p>ignored</p>") } },
              ],
            },
            { mimeType: "application/pdf", body: {} },
          ],
        }),
        full("m2", 2_000, {
          mimeType: "text/html",
          headers: [header("From", "bob@x.com"), header("Cc", "c@x.com")],
          body: {
            data: b64(
              "<html><head><style>p{}</style></head><body><p>Uno &amp; dos</p><br>tres&nbsp;&#241;&#x263A;<script>x()</script></body></html>",
            ),
          },
        }),
        full("m3", 3_000, { mimeType: "multipart/mixed", headers: [], parts: [] }),
        full("m4", 4_000, {
          mimeType: "text/plain",
          headers: [],
          body: {
            data: b64('<!DOCTYPE html PUBLIC "x"><html><body><p>Pedido listo</p></body></html>'),
          },
        }),
      ],
    };
    const t = await googleClient(connected()).thread("a1");
    expect(calls).toEqual([path]);
    expect(t.subject).toBe("Factura");
    expect(t.link).toContain("#inbox/a1");
    expect(t.messages.map((m) => [m.id, m.from, m.to, m.cc, m.body])).toEqual([
      ["m1", "ana@x.com", "me@gmail.com", null, "Hola,\n¿qué tal?"],
      ["m2", "bob@x.com", null, "c@x.com", "Uno & dos\n\ntres ñ☺"],
      ["m3", "", null, null, null],
      ["m4", "", null, null, "Pedido listo"],
    ]);
  });

  test("a body over 64 KiB is cut and says so", async () => {
    routes[path] = {
      id: "a1",
      messages: [
        full("m1", 1, {
          mimeType: "text/plain",
          headers: [],
          body: { data: b64("x".repeat(70_000)) },
        }),
      ],
    };
    const [m] = (await googleClient(connected()).thread("a1")).messages;
    expect(m?.body?.length).toBe(64 * 1024);
    expect(m?.truncated).toBe(true);
  });

  test("an id that is not a Gmail id never reaches the URL", async () => {
    await expect(googleClient(connected()).thread("../profile")).rejects.toThrow(
      "invalid thread id",
    );
    expect(calls).toEqual([]);
  });

  test("a failed read is a provider error", async () => {
    await expect(googleClient(connected()).thread("a1")).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("profile", () => {
  const meta = (id: string, from: string, labels: string[] = [], to = "") => ({
    id,
    labelIds: labels,
    payload: { headers: [header("From", from), ...(to ? [header("To", to)] : [])] },
  });

  test("addresses keep each name and lower-case the address, commas in quotes included", () => {
    expect(addresses('"Pérez, Ana" <Ana@X.com>, bob@y.com')).toEqual([
      { address: "ana@x.com", name: "Pérez, Ana" },
      { address: "bob@y.com", name: "bob@y.com" },
    ]);
    expect(addresses("undisclosed-recipients:;")).toEqual([]);
  });

  test("counts what is deleted, filed and written to, and how much each sender stays unread", () => {
    const p = toProfile({
      me: "me@gmail.com",
      trash: [meta("t1", "Shop <news@shop.com>"), meta("t2", "news@shop.com")],
      sent: [meta("s1", "me@gmail.com", [], "Ana <ana@x.com>, me@gmail.com")],
      recent: [
        meta("r1", "news@shop.com", ["UNREAD", "CATEGORY_PROMOTIONS"]),
        meta("r2", "news@shop.com", ["CATEGORY_PROMOTIONS"]),
        meta("r3", "ana@x.com", []),
      ],
      labels: [
        { name: "Compras", messages: [meta("l1", "Amazon <pedidos@amazon.es>")] },
        { name: "Vacía", messages: [] },
      ],
    });
    expect(p.trash).toEqual([{ address: "news@shop.com", name: "Shop", count: 2 }]);
    expect(p.correspondents).toEqual([{ address: "ana@x.com", name: "Ana", count: 1 }]);
    expect(p.labels).toEqual([
      { name: "Compras", senders: [{ address: "pedidos@amazon.es", name: "Amazon", count: 1 }] },
    ]);
    expect(p.senders[0]).toEqual({
      address: "news@shop.com",
      name: "news@shop.com",
      count: 2,
      unread: 1,
      category: "PROMOTIONS",
    });
    expect(p.sampled).toEqual({ trash: 2, sent: 1, recent: 3, labels: 1 });
  });

  test("reads trash, sent, recent mail and each user label by id, and nothing when Gmail fails", async () => {
    const base = "/gmail/v1/users/me/messages";
    routes["/gmail/v1/users/me/labels"] = {
      labels: [
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "Label_1", name: "Viajes/2026", type: "user" },
      ],
    };
    routes[`${base}?in:trash`] = { messages: [{ id: "m1" }] };
    routes[`${base}?in:sent`] = {};
    routes[`${base}?-in:sent -in:trash -in:spam -in:chats`] = {};
    routes[`${base}?`] = { messages: [{ id: "m2" }] };
    routes[`${base}/m1`] = meta("m1", "news@shop.com");
    routes[`${base}/m2`] = meta("m2", "vuelos@air.com");
    const p = await googleClient(connected()).profile();
    expect(p.trash.map((s) => s.address)).toEqual(["news@shop.com"]);
    expect(p.labels).toEqual([
      {
        name: "Viajes/2026",
        senders: [{ address: "vuelos@air.com", name: "vuelos@air.com", count: 1 }],
      },
    ]);

    delete routes[`${base}/m2`];
    await expect(googleClient(connected()).profile()).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("quota", () => {
  test("spends the burst at once, then waits for the refill", async () => {
    const spend = quota(10, 100);
    const start = performance.now();
    await spend(10);
    expect(performance.now() - start).toBeLessThan(15);
    await spend(5);
    expect(performance.now() - start).toBeGreaterThanOrEqual(45);
  });

  test("callers in flight queue behind each other", async () => {
    const spend = quota(0, 100);
    const start = performance.now();
    await Promise.all([spend(5), spend(5)]);
    expect(performance.now() - start).toBeGreaterThanOrEqual(95);
  });
});
