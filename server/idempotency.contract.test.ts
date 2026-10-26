import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { SERVER_ERRORS } from "./app-errors.ts";
import { ConfigSchema } from "./config.ts";
import { openDb } from "./db.ts";
import { errorHandler } from "./errors.ts";
import { Messenger } from "./features/coordination/messages.ts";
import { coordinationRoutes } from "./features/coordination/routes.ts";
import { CoordinationStore } from "./features/coordination/store.ts";
import { EventBus } from "./features/events/bus.ts";
import type { GithubClient } from "./features/github/prs.ts";
import { jiraClient } from "./features/jira/client.ts";
import type { TerminalInfo, Terminals } from "./features/terminals/contract.ts";
import { LaunchError } from "./features/terminals/harness.ts";
import { LaunchRequests } from "./features/terminals/launch-requests.ts";
import { WorkboardStore } from "./features/workboard/store.ts";
import { WorkspaceStore } from "./features/workspace/store.ts";
import { localGuard } from "./local-guard.ts";
import { LEDGER_KEEP_MS } from "./retention.ts";

// One contract for the four request ledgers. A ledger maps a request id to the first result:
// a retry replays it, never re-runs the work, never re-checks state that changed since, and
// a retry that arrives while the first is still running joins it. Rows are pruned after
// LEDGER_KEEP_MS. Each adapter maps a small "input" token onto its own request shape.
type Ledger = {
  submit(key: string, input: "a" | "b" | "c"): Promise<unknown>;
  // Times the work behind a request really ran (a launch started, a row was written).
  executions(): Promise<number>;
  // Changes state so that a fresh request with input "a" is now refused.
  invalidate(): void;
  rows(): Promise<number>;
  close(): Promise<void>;
};

const HOUR = 60 * 60 * 1000;
const T0 = new Date("2026-10-01T00:00:00Z").getTime();
const dirs: string[] = [];
afterEach(async () => {
  setSystemTime();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const count = (db: ReturnType<typeof openDb>, sql: string) =>
  db.query<{ n: number }, []>(sql).get()?.n ?? 0;

function workspace(): Ledger {
  const db = openDb(":memory:");
  let writes = 0;
  const store = new WorkspaceStore(db, () => writes++);
  store.apply({
    requestId: crypto.randomUUID(),
    expectedRevision: 0,
    action: { kind: "import", mesas: [{ id: "base", name: "Base", ids: [] }] },
  });
  const base = writes;
  return {
    async submit(key, input) {
      // Adding a tile is refused once its Mesa is gone: state the replay must not re-check.
      return store.apply({
        requestId: key,
        action: { kind: "intent", intent: { kind: "add", mesa: "base", tile: `t-${input}` } },
      });
    },
    executions: async () => writes - base,
    invalidate() {
      db.run("UPDATE workspace_state SET body=?", [
        JSON.stringify([{ id: "other", name: "Other", ids: [] }]),
      ]);
    },
    rows: async () => count(db, "SELECT count(*) n FROM workspace_requests"),
    close: async () => db.close(),
  };
}

function launches(): Ledger {
  const db = openDb(":memory:");
  const ledger = new LaunchRequests(db);
  let starts = 0;
  let full = false;
  return {
    submit(key, input) {
      return ledger.run({ requestId: key, harness: "shell", location: input }, async () => {
        if (full) throw new LaunchError("at most 12 terminals");
        starts++;
        await Bun.sleep(5);
        return {
          id: `t-${input}-${starts}`,
          harness: "shell",
          location: input,
          cwd: "/tmp",
          ticket: null,
          name: null,
          env: null,
          action: null,
          state: "running",
          exitCode: null,
          signal: null,
          error: null,
          overflowed: false,
          attached: false,
          activity: null,
          lastOutputAt: null,
          pid: starts,
          startedAt: new Date().toISOString(),
          endedAt: null,
        } satisfies TerminalInfo;
      });
    },
    executions: async () => starts,
    invalidate() {
      full = true;
    },
    rows: async () => count(db, "SELECT count(*) n FROM terminal_launch_requests"),
    close: async () => db.close(),
  };
}

function coordination(): Ledger {
  const db = openDb(":memory:");
  const agents = ["sender", "recipient"].map((id) => ({
    id,
    harness: "claude",
    state: "running",
    startedAt: "generation",
    location: "app",
  })) as TerminalInfo[];
  const terminals = {
    env: Promise.resolve({}),
    list: () => agents,
    get: async (id: string) => agents.find((a) => a.id === id),
    subscribe: () => () => {},
    write: () => true,
  } as unknown as Terminals;
  const config = ConfigSchema.parse({ providers: { jira: false, github: false } });
  const deps = { config, db, terminals, jira: jiraClient(db) };
  const store = new CoordinationStore(db);
  const app = new Hono()
    .use("*", localGuard([4317]))
    .route(
      "/c",
      coordinationRoutes(
        {
          ...deps,
          github: {} as GithubClient,
          bus: new EventBus([], 0),
          coordination: store,
          messenger: new Messenger(store, terminals),
        },
        {
          dir: tmpdir(),
          inspect: async () => [],
        },
      ),
    )
    .onError(errorHandler(SERVER_ERRORS));
  return {
    async submit(key, input) {
      const response = await app.request("/c/messages", {
        method: "POST",
        headers: {
          host: "localhost:4317",
          origin: "http://localhost:4317",
          "content-type": "application/json",
          "x-aos-agent-id": "sender",
        },
        body: JSON.stringify({ requestId: key, to: "recipient", text: input }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      // Delivery settles after the reply (text, then Enter); only settled rows can age out.
      while (
        db
          .query<{ s: string }, [string]>(
            "SELECT json_extract(body,'$.status') s FROM coordination_records WHERE id=?",
          )
          .get(body.id)
          ?.s.match(/^(pending|delivering)$/)
      )
        await Bun.sleep(20);
      return body.id;
    },
    executions: async () => count(db, "SELECT count(*) n FROM coordination_records"),
    invalidate() {
      agents.splice(1); // the recipient's terminal is gone
    },
    rows: async () => count(db, "SELECT count(*) n FROM coordination_records"),
    close: async () => {}, // delivery runs on after the reply; the in-memory DB is dropped
  };
}

async function workboard(): Promise<Ledger> {
  const dir = await mkdtemp(join(tmpdir(), "aos-idempotency-"));
  dirs.push(dir);
  const path = join(dir, "sessions.json");
  const store = new WorkboardStore(path);
  const decision = (id: string) => ({
    id,
    revision: 1,
    question: "Choose",
    options: ["a", "b"],
    blocking: false,
    state: "pending" as const,
  });
  const session = (decisions: string[]) => ({
    version: 1 as const,
    sessionId: "session",
    cwd: "/repo",
    ticket: null,
    tasks: [],
    agents: [],
    checks: [],
    working: true,
    robin: null,
    failure: null,
    decisions: decisions.map(decision),
  });
  await store.publish("actor", session(["a", "b", "c"]));
  const answers = async () => JSON.parse(await readFile(path, "utf8")).answers.length;
  return {
    async submit(key, input) {
      // Each input answers its own decision; a second answer to one decision is refused.
      await store.respond({
        sessionId: "session",
        decisionId: input,
        revision: 1,
        response: input,
        requestId: key,
      });
      return `${key}:${input}`;
    },
    executions: answers,
    invalidate() {
      // The agent got the answer and closed the decision (A7: the retry must still succeed).
      void store.publish("actor", session(["b", "c"]));
    },
    rows: answers,
    close: async () => {},
  };
}

const ledgers: [string, () => Ledger | Promise<Ledger>][] = [
  ["workspace", workspace],
  ["terminal launches", launches],
  ["coordination messages", coordination],
  ["workboard responses", workboard],
];

describe.each(ledgers)("%s ledger", (_name, make) => {
  const [r1, r2, r3] = [0, 1, 2].map(() => crypto.randomUUID()) as [string, string, string];
  test("a retry with the same id and input replays the first result once", async () => {
    const ledger = await make();
    const first = await ledger.submit(r1, "a");
    expect(await ledger.submit(r1, "a")).toEqual(first);
    expect(await ledger.executions()).toBe(1);
    await ledger.close();
  });

  test("the same id with another input is a request_conflict", async () => {
    const ledger = await make();
    await ledger.submit(r1, "a");
    await expect(ledger.submit(r1, "b")).rejects.toThrow(/request_conflict/);
    expect(await ledger.executions()).toBe(1);
    await ledger.close();
  });

  test("the duplicate is looked up before validating state that changed", async () => {
    const ledger = await make();
    const first = await ledger.submit(r1, "a");
    ledger.invalidate();
    await Bun.sleep(1);
    await expect(ledger.submit(r2, "a")).rejects.toThrow();
    expect(await ledger.submit(r1, "a")).toEqual(first);
    expect(await ledger.executions()).toBe(1);
    await ledger.close();
  });

  test("a retry while the first is in flight joins it", async () => {
    const ledger = await make();
    const [one, two] = await Promise.all([ledger.submit(r1, "a"), ledger.submit(r1, "a")]);
    expect(two).toEqual(one);
    expect(await ledger.executions()).toBe(1);
    await ledger.close();
  });

  test("rows are kept past 24 h and pruned after the retention window", async () => {
    expect(LEDGER_KEEP_MS).toBeGreaterThanOrEqual(24 * HOUR);
    setSystemTime(T0);
    const ledger = await make();
    await ledger.submit(r1, "a");
    setSystemTime(T0 + 25 * HOUR);
    await ledger.submit(r1, "a");
    await ledger.submit(r2, "b");
    expect(await ledger.rows()).toBeGreaterThanOrEqual(2);
    expect(await ledger.executions()).toBe(2);
    setSystemTime(T0 + LEDGER_KEEP_MS + 26 * HOUR);
    const before = await ledger.rows();
    await ledger.submit(r3, "c");
    // r1 and r2 aged out; at most the new row is left.
    expect(await ledger.rows()).toBeLessThan(before);
    expect(await ledger.rows()).toBeLessThanOrEqual(1);
    await ledger.close();
  });
});
