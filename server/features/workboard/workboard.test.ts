import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { WorkSession } from "../../../shared/workboard.ts";
import { errorHandler } from "../../errors.ts";
import { localGuard } from "../../local-guard.ts";
import { ticketMatches, workboardActor, workboardReleased } from "./context.ts";
import { workboardRoutes } from "./routes.ts";
import { WorkboardStore } from "./store.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const session = (): WorkSession => ({
  version: 1,
  sessionId: "session",
  cwd: "/repo",
  ticket: "ABC-12",
  tasks: [],
  agents: [],
  checks: [],
  working: true,
  robin: null,
  failure: null,
  decisions: [
    {
      id: "d",
      revision: 1,
      question: "Choose",
      options: ["A", "B"],
      blocking: false,
      state: "pending",
    },
  ],
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "aos-workboard-"));
  dirs.push(dir);
  return {
    path: join(dir, "sessions.json"),
    store: new WorkboardStore(join(dir, "sessions.json")),
  };
}
test("exact ticket match never associates neighbouring ticket numbers", () => {
  expect(ticketMatches("feature/ABC-12-ui", "ABC-12")).toBe(true);
  expect(ticketMatches("abc-123", "ABC-12")).toBe(false);
  expect(ticketMatches("XABC-12", "ABC-12")).toBe(false);
});
test("responses persist, are idempotent, and publishing old state cannot erase them", async () => {
  const { store, path } = await fixture();
  await store.publish("actor", session());
  const response = {
    sessionId: "session",
    decisionId: "d",
    revision: 1,
    response: "A",
    requestId: "r1",
  };
  await store.respond(response);
  await store.respond(response);
  await expect(store.respond({ ...response, response: "B", requestId: "r2" })).rejects.toThrow();
  await store.publish("actor", session());
  expect((await new WorkboardStore(path).list())[0]?.decisions[0]).toMatchObject({
    state: "queued",
    response: "A",
  });
  await expect(store.ack("other", { ...response, delivered: true })).rejects.toThrow();
  await store.ack("actor", { ...response, delivered: true });
  expect((await store.list())[0]?.decisions[0]?.state).toBe("delivered");
});
test("changed or cancelled decisions refuse obsolete responses and acknowledgements", async () => {
  const { store } = await fixture();
  await store.publish("actor", session());
  const s = session();
  s.decisions = s.decisions.map((d) => ({ ...d, revision: 2, state: "cancelled" }));
  await store.publish("actor", s);
  await expect(
    store.respond({
      sessionId: "session",
      decisionId: "d",
      revision: 1,
      response: "A",
      requestId: "r1",
    }),
  ).rejects.toThrow();
});
test("HTTP boundary rejects cross-origin writes, invalid payloads and spoofed session cwd", async () => {
  const { store } = await fixture();
  const routes = workboardRoutes({
    store,
    context: async () => ({ repos: [], sessions: [], errors: [] }),
    actor: async (id, input) => {
      if (id !== "actor" || (input && input.cwd !== "/repo")) throw Error("unknown actor");
      return id;
    },
  });
  const app = new Hono().use("*", localGuard([4317])).route("/api/workboard", routes);
  const headers = {
    host: "localhost:4317",
    origin: "http://localhost:4317",
    "content-type": "application/json",
    "x-aos-agent-id": "actor",
  };
  const request = (body: unknown, extra = {}) =>
    app.request("http://localhost:4317/api/workboard/session", {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
    });
  expect((await request(session(), { origin: "https://evil.example" })).status).toBe(403);
  expect((await request({ ...session(), tasks: "wrong" })).status).toBe(400);
  expect((await request({ ...session(), cwd: "/other" })).status).toBe(403);
  expect(
    (await request({ ...session(), decisions: [...session().decisions, ...session().decisions] }))
      .status,
  ).toBe(400);
  expect((await request({ padding: "x".repeat(70000) })).status).toBe(413);
  expect((await request(session())).status).toBe(200);
});

test("real HTTP round trip persists a response until its owning session acknowledges it", async () => {
  const { store } = await fixture();
  let port = 0;
  const routes = workboardRoutes({
    store,
    context: async () => ({ repos: [], sessions: [], errors: [] }),
    actor: async (id) => {
      if (id !== "actor") throw Error("Unknown actor");
      return id;
    },
  });
  const app = new Hono()
    .use("*", (c, next) => localGuard([port])(c, next))
    .route("/api/workboard", routes);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  port = server.port ?? 0;
  const origin = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown) =>
    fetch(`${origin}/api/workboard${path}`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", "x-aos-agent-id": "actor" },
      body: JSON.stringify(body),
    });
  try {
    expect((await post("/session", session())).status).toBe(200);
    const response = {
      sessionId: "session",
      decisionId: "d",
      revision: 1,
      requestId: "r1",
      response: "A",
    };
    expect((await post("/response", response)).status).toBe(200);
    const context = await (
      await fetch(`${origin}/api/workboard/context?ticket=ABC-12&cwd=/repo`)
    ).json();
    expect(context.published[0].decisions[0].state).toBe("queued");
    expect((await post("/ack", { ...response, delivered: true })).status).toBe(200);
    expect((await store.list())[0]?.decisions[0]?.state).toBe("delivered");
    expect((await post("/response", { ...response, requestId: "r2" })).status).toBe(409);
  } finally {
    server.stop(true);
  }
});

test("managed actor identity binds session and canonical cwd to a running agent terminal", async () => {
  const { path } = await fixture();
  const cwd = path.slice(0, path.lastIndexOf("/"));
  const actor = workboardActor({
    get: async (id: string) =>
      id === "actor"
        ? { state: "running", harness: "claude", cwd, agent: { sessionId: "session" } }
        : null,
  } as never);
  await expect(actor("actor", { ...session(), cwd })).resolves.toBe("actor");
  await expect(actor("unknown", { ...session(), cwd })).rejects.toThrow();
  await expect(actor("actor", { ...session(), cwd, sessionId: "other" })).rejects.toThrow();
  await expect(actor("actor", { ...session(), cwd: tmpdir() })).rejects.toThrow();
});
test("idle sessions are pruned and a full board makes room for a new one (A6)", async () => {
  const { store } = await fixture();
  const start = Date.now();
  try {
    setSystemTime(start - 8 * 24 * 60 * 60 * 1000);
    await store.publish("actor", { ...session(), sessionId: "idle" });
    setSystemTime(start);
    for (let i = 0; i < 100; i++)
      await store.publish("actor", { ...session(), sessionId: `s${i}` });
    const ids = (await store.list()).map((s) => s.sessionId);
    expect(ids).toHaveLength(100);
    expect(ids).not.toContain("idle");
    setSystemTime(start + 1000);
    await store.publish("actor", { ...session(), sessionId: "newest" });
    const after = (await store.list()).map((s) => s.sessionId);
    expect(after).toHaveLength(100);
    expect(after).toContain("newest");
    expect(after).not.toContain("s0");
  } finally {
    setSystemTime();
  }
}, 30_000); // 101 atomic file writes; slow under machine load

test("a resumed session moves to its new terminal only once the old one released it", async () => {
  const { store } = await fixture();
  const live = new Set(["old"]);
  const routes = workboardRoutes({
    store,
    context: async () => ({ repos: [], sessions: [], errors: [] }),
    actor: async (id) => {
      if (!id) throw Error("unknown actor");
      return id;
    },
    released: async (id) => !live.has(id),
  });
  const app = new Hono().use("*", localGuard([4317])).route("/api/workboard", routes);
  const publish = (actor: string) =>
    app.request("http://localhost:4317/api/workboard/session", {
      method: "POST",
      headers: {
        host: "localhost:4317",
        origin: "http://localhost:4317",
        "content-type": "application/json",
        "x-aos-agent-id": actor,
      },
      body: JSON.stringify(session()),
    });
  expect((await publish("old")).status).toBe(200);
  // While the old terminal still holds it, another one cannot take the session.
  expect((await publish("new")).status).toBe(409);
  live.delete("old");
  expect((await publish("new")).status).toBe(200);
  expect((await store.list()).find((s) => s.sessionId === "session")?.actor).toBe("new");
  // And the old owner cannot take it back while the new one holds it.
  live.add("new");
  expect((await publish("old")).status).toBe(409);
});

test("a terminal lookup that fails is a server failure, not a conflict over the session", async () => {
  const { store } = await fixture();
  const routes = workboardRoutes({
    store,
    context: async () => ({ repos: [], sessions: [], errors: [] }),
    actor: async (id) => id ?? "",
    released: async () => {
      throw new Error("PTY host unavailable");
    },
  });
  const app = new Hono().route("/api/workboard", routes).onError(errorHandler([]));
  const publish = (actor: string) =>
    app.request("/api/workboard/session", {
      method: "POST",
      headers: { "content-type": "application/json", "x-aos-agent-id": actor },
      body: JSON.stringify(session()),
    });
  expect((await publish("old")).status).toBe(200);
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  expect((await publish("new")).status).toBe(500);
  quiet.mockRestore();
});

test("a terminal releases a session once it stops running or moves to another", async () => {
  const terminals = {
    gone: { state: "exited", agent: { sessionId: "session" } },
    moved: { state: "running", agent: { sessionId: "other" } },
    holds: { state: "running", agent: { sessionId: "session" } },
  } as Record<string, unknown>;
  const released = workboardReleased({ get: async (id: string) => terminals[id] ?? null } as never);
  expect(await released("gone", "session")).toBe(true);
  expect(await released("moved", "session")).toBe(true);
  expect(await released("missing", "session")).toBe(true);
  expect(await released("holds", "session")).toBe(false);
});
