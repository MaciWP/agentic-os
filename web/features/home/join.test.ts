import { describe, expect, test } from "bun:test";
import { terminal } from "../terminals/test-fixtures.ts";
import { buildInbox } from "./inbox.ts";
import { byTicket, keyIn } from "./join.ts";
import { outside, pr, snapshot, ticket } from "./test-fixtures.ts";

const KEYS = ["AB-7", "AB-12"];

describe("keyIn", () => {
  test("finds a known key as a whole word, any case", () => {
    expect(keyIn("/work/ab-7/api", KEYS)).toBe("AB-7");
    expect(keyIn("feat(AB-12): borrar", KEYS)).toBe("AB-12");
  });

  test("a longer key or an unknown one names nothing", () => {
    expect(keyIn("/work/ab-70/api", KEYS)).toBeNull();
    expect(keyIn("ZZ-1 fix", KEYS)).toBeNull();
    expect(keyIn(null, KEYS)).toBeNull();
  });
});

describe("byTicket", () => {
  const tickets = [ticket("AB-12", "indeterminate"), ticket("AB-7", "new")];

  test("links agents by field or path, sessions by path, PRs by title; the rest is loose", () => {
    const inbox = buildInbox({
      terminals: [
        terminal({ id: "by-field", ticket: "AB-7", agent: { sessionId: null, state: "working" } }),
        terminal({
          id: "by-path",
          cwd: "/work/ab-12/api",
          agent: { sessionId: null, state: "working" },
        }),
        terminal({ id: "none", cwd: "/work/other", agent: { sessionId: null, state: "working" } }),
      ],
      agents: snapshot({ outside: [outside("s1", { cwd: "/work/ab-7/web", status: "busy" })] }),
      prs: [pr(1, "mine", undefined, "AB-12: borrado lógico"), pr(2, "mine")],
      tickets,
    });
    const { work, loose } = byTicket(tickets, inbox);
    const of = (key: string) =>
      work.find((w) => w.ticket.key === key)?.items.map((l) => `${l.item.id}:${l.link}`);
    expect(of("AB-7")).toEqual(["by-field:field", "claude:s1:path"]);
    expect(of("AB-12")).toEqual(["by-path:path", "acme/api#1:title"]);
    expect(loose.map((l) => l.item.id)).toEqual(["none", "acme/api#2"]);
  });

  test("an agent set to a goal goes to that goal's lane, even from a ticket's folder", () => {
    const goal = { kind: "goal" as const, id: 3, title: "Refactor the host", closedAt: null };
    const working = { sessionId: null, state: "working" as const };
    const inbox = buildInbox({
      terminals: [
        terminal({ id: "g1", cwd: "/work/ab-7/api", objective: goal, agent: working }),
        terminal({ id: "g2", objective: goal, agent: working }),
        terminal({ id: "t", ticket: "AB-7", agent: working }),
      ],
      tickets,
    });
    const { work, goals, loose } = byTicket(tickets, inbox);
    expect(goals.map((g) => [g.goal, g.items.map((l) => l.item.id).sort()])).toEqual([
      [{ id: 3, title: "Refactor the host" }, ["g1", "g2"]],
    ]);
    expect(work.find((w) => w.ticket.key === "AB-7")?.items.map((l) => l.item.id)).toEqual(["t"]);
    expect(loose).toEqual([]);
  });

  test("a ticket holding an interruption comes first, its most urgent item on top", () => {
    const inbox = buildInbox({
      terminals: [
        terminal({ id: "works", ticket: "AB-7", agent: { sessionId: null, state: "working" } }),
        terminal({ id: "lost", ticket: "AB-7", state: "lost" }),
      ],
      tickets,
    });
    const { work } = byTicket(tickets, inbox);
    expect(work.map((w) => w.ticket.key)).toEqual(["AB-7", "AB-12"]);
    expect(work[0]?.urgency).toBe("failed");
    expect(work[0]?.items.map((l) => l.item.id)).toEqual(["lost", "works"]);
    expect(work[1]?.urgency).toBeNull();
  });
});
