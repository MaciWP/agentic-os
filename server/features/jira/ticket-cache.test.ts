import { describe, expect, test } from "bun:test";
import { ConfigSchema } from "../../config.ts";
import { openDb } from "../../db.ts";
import type { Services } from "../../deps.ts";
import { EventBus } from "../events/bus.ts";
import { jiraClient } from "./client.ts";
import {
  boardLoader,
  pageBoards,
  TICKETS_TTL_MS,
  teamLoader,
  ticketLoader,
  ticketRoutes,
} from "./routes.ts";

const config = ConfigSchema.parse({ terminals: { shell: "/bin/sh" } });
const db = openDb(":memory:");
const list = (...keys: string[]) => ({ jql: "q", tickets: keys.map((key) => ({ key }) as never) });
type Result = ReturnType<typeof list> | { disabled: true };

// A Jira that counts its searches and answers when told to, on a clock the test moves.
function fakeJira() {
  const pending: { resolve: (v: Result) => void; reject: (e: Error) => void }[] = [];
  let clock = 0;
  const jira = {
    calls: 0,
    tick: (ms: number) => {
      clock += ms;
    },
    // Answers the oldest search still waiting, or the one at `index`.
    answer: (value: Result, index = 0) => pending.splice(index, 1)[0]?.resolve(value),
    fail: (message: string) => pending.shift()?.reject(new Error(message)),
    loader: () =>
      ticketLoader(
        { config, jira: jiraClient(db) },
        {
          now: () => clock,
          search: () => {
            jira.calls++;
            return new Promise<Result>((resolve, reject) => pending.push({ resolve, reject }));
          },
        },
      ),
  };
  return jira;
}

describe("ticket cache", () => {
  test("a second read within 60 s makes no Jira call; after 60 s it searches again", async () => {
    const jira = fakeJira();
    const tickets = jira.loader();
    const first = tickets.get();
    jira.answer(list("A-1"));
    expect(await first).toEqual(list("A-1"));
    jira.tick(TICKETS_TTL_MS - 1);
    expect(await tickets.get()).toEqual(list("A-1"));
    expect(jira.calls).toBe(1);
    jira.tick(1);
    const third = tickets.get();
    jira.answer(list("A-2"));
    expect(await third).toEqual(list("A-2"));
    expect(jira.calls).toBe(2);
  });

  test("the team's list past 60 s answers at once and says when the search behind it changed", async () => {
    let clock = 0;
    let calls = 0;
    let changed = 0;
    const answers = [list("A-1"), list("A-1"), list("A-2")];
    const team = teamLoader(
      { config, jira: jiraClient(db) },
      {
        now: () => clock,
        search: async () => answers[calls++] as never,
        onChange: () => changed++,
      },
    );
    expect(await team.get()).toEqual(list("A-1") as never);
    clock = TICKETS_TTL_MS;
    // Kept list at once; the same list behind it is no change.
    expect(await team.get()).toEqual(list("A-1") as never);
    await Bun.sleep(0);
    expect([calls, changed]).toEqual([2, 0]);
    clock = 2 * TICKETS_TTL_MS;
    expect(await team.get()).toEqual(list("A-1") as never);
    await Bun.sleep(0);
    expect([calls, changed]).toEqual([3, 1]);
    expect(await team.get()).toEqual(list("A-2") as never);
  });

  test("fresh skips the kept list, and concurrent reads share one search", async () => {
    const jira = fakeJira();
    const tickets = jira.loader();
    const a = tickets.get();
    jira.answer(list("A-1"));
    await a;
    const fresh = tickets.get({ fresh: true });
    const joined = tickets.get(); // a page read during the watcher's refresh
    const alsoFresh = tickets.get({ fresh: true });
    expect(jira.calls).toBe(2);
    jira.answer(list("B-1"));
    expect(await Promise.all([fresh, joined, alsoFresh])).toEqual([
      list("B-1"),
      list("B-1"),
      list("B-1"),
    ]);
  });

  test("a failure is never kept, and a failed fresh load drops the kept success", async () => {
    const jira = fakeJira();
    const tickets = jira.loader();
    const ok = tickets.get();
    jira.answer(list("A-1"));
    await ok;
    const failed = tickets.get({ fresh: true });
    jira.fail("Jira is down");
    expect(failed).rejects.toThrow("Jira is down");
    await failed.catch(() => {});
    const next = tickets.get(); // within 60 s, yet it must not show the old list
    expect(jira.calls).toBe(3);
    jira.fail("still down");
    expect(next).rejects.toThrow("still down");
    await next.catch(() => {});
  });

  test("disabled is never kept", async () => {
    const jira = fakeJira();
    const tickets = jira.loader();
    for (let i = 0; i < 2; i++) {
      const read = tickets.get();
      jira.answer({ disabled: true });
      expect(await read).toEqual({ disabled: true });
    }
    expect(jira.calls).toBe(2);
  });

  test("invalidate drops the kept list and a load already running", async () => {
    const jira = fakeJira();
    const tickets = jira.loader();
    const old = tickets.get();
    tickets.invalidate(); // a new Jira connection while the old search runs
    const next = tickets.get();
    expect(jira.calls).toBe(2);
    jira.answer(list("NEW"), 1);
    expect(await next).toEqual(list("NEW"));
    jira.answer(list("OLD")); // the stale search ends last and must not replace the list
    expect(await old).toEqual(list("OLD"));
    expect(await tickets.get()).toEqual(list("NEW"));
    expect(jira.calls).toBe(2);
    tickets.invalidate();
    const after = tickets.get();
    expect(jira.calls).toBe(3);
    jira.answer(list("NEW"));
    await after;
  });

  test("the watcher's baseline uses the kept list; its later checks ask Jira and publish a change", async () => {
    const jira = fakeJira();
    const tickets = jira.loader();
    const page = tickets.get();
    jira.answer(list("A-1"));
    await page;
    const bus = new EventBus(
      [
        {
          topic: "tickets",
          everyMs: 20,
          load: ({ baseline }) => tickets.get({ fresh: !baseline }),
        },
      ],
      1,
    );
    const got: string[] = [];
    const unsubscribe = bus.subscribe((t) => got.push(t));
    await Bun.sleep(5);
    expect(jira.calls).toBe(1); // the baseline came from the kept list
    while (jira.calls < 2) await Bun.sleep(5);
    jira.answer(list("A-1", "A-2"));
    while (got.length === 0) await Bun.sleep(5);
    unsubscribe();
    expect(got).toEqual(["tickets"]);
    jira.answer(list("A-1", "A-2")); // a check that may have started meanwhile
  });

  test("GET /api/tickets keeps the list, and ?fresh=1 asks Jira again", async () => {
    const jira = fakeJira();
    const tickets = jira.loader();
    const app = ticketRoutes(
      { config, db, jira: jiraClient(db) } as Services,
      tickets,
      teamLoader({ config, jira: jiraClient(db) }),
      boardLoader({ config, jira: jiraClient(db) }),
    );
    const get = async (path: string, value: Result) => {
      const res = app.request(path);
      await Bun.sleep(1);
      jira.answer(value);
      return (await res).json();
    };
    expect(await get("/", list("A-1"))).toEqual(list("A-1"));
    expect(await get("/", list("unused"))).toEqual(list("A-1"));
    expect(jira.calls).toBe(1);
    expect(await get("/?fresh=1", list("A-2"))).toEqual(list("A-2"));
    expect(jira.calls).toBe(2);
  });

  test("POST /:key/reviewer refuses a bad key before any write", async () => {
    const jira = fakeJira();
    const app = ticketRoutes(
      { config, db, jira: jiraClient(db) } as Services,
      jira.loader(),
      teamLoader({ config, jira: jiraClient(db) }),
      boardLoader({ config, jira: jiraClient(db) }),
    );
    const res = await app.request("/abc 1 OR x/reviewer", { method: "POST" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_key" });
    expect(jira.calls).toBe(0);
  });
});

describe("boards", () => {
  const column = (name: string, ...statuses: string[]) => ({ name, statuses });
  const withBoards = ConfigSchema.parse({
    terminals: { shell: "/bin/sh" },
    jira: {
      site: "https://example.atlassian.net",
      project: "ABC",
      boards: [
        {
          id: "sprint",
          name: "Sprint",
          jql: "sprint in openSprints()",
          columns: [column("TO DO", "20003", "20002"), column("PR", "20004")],
        },
        { id: "refinamiento", name: "Refinamiento", columns: [column("QUÉ", "20002")] },
      ],
    },
  });
  const board = (id: string) => ({
    board: { id, name: id, columns: null },
    boards: [],
    jql: "q",
    tickets: [],
    me: null,
  });

  test("each configured board gets its own JQL; without any, one board of every open ticket", () => {
    if (!withBoards.jira) throw new Error("jira expected");
    expect(pageBoards(withBoards.jira).map((b) => [b.id, b.jql])).toEqual([
      [
        "sprint",
        "project = ABC AND statusCategory != Done AND (sprint in openSprints()) AND status in (20003, 20002, 20004) ORDER BY Rank ASC",
      ],
      [
        "refinamiento",
        "project = ABC AND statusCategory != Done AND status in (20002) ORDER BY Rank ASC",
      ],
    ]);
    const { boards: _, ...bare } = withBoards.jira;
    expect(pageBoards({ ...bare, boards: [] })).toEqual([
      {
        id: "open",
        name: "Abiertos",
        columns: null,
        jql: "project = ABC AND statusCategory != Done ORDER BY updated DESC",
      },
    ]);
  });

  test("keeps one list per board, and invalidate drops them all", async () => {
    const calls: string[] = [];
    const boards = boardLoader(
      { config: withBoards, jira: jiraClient(db) },
      {
        search: (id) => async () => {
          calls.push(id);
          return board(id);
        },
      },
    );
    await boards.load("sprint");
    await boards.load("sprint");
    await boards.load("refinamiento");
    expect(calls).toEqual(["sprint", "refinamiento"]);
    boards.invalidate();
    await boards.load("sprint");
    await boards.load("refinamiento");
    expect(calls).toEqual(["sprint", "refinamiento", "sprint", "refinamiento"]);
  });

  test("GET /board answers the first board, a configured one, and 404 for any other", async () => {
    const calls: string[] = [];
    const deps = { config: withBoards, db, jira: jiraClient(db) } as Services;
    const app = ticketRoutes(
      deps,
      ticketLoader(deps),
      teamLoader(deps),
      boardLoader(deps, {
        search: (id) => async () => {
          calls.push(id);
          return board(id);
        },
      }),
    );
    expect(await (await app.request("/board")).json()).toEqual(board("sprint"));
    const ok = await app.request("/board?id=refinamiento");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(board("refinamiento"));
    const missing = await app.request("/board?id=otro");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "unknown_board" });
    expect(calls).toEqual(["sprint", "refinamiento"]);
  });
});
