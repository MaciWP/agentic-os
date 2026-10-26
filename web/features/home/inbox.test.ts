import { describe, expect, test } from "bun:test";
import { terminal } from "../terminals/test-fixtures.ts";
import { buildInbox, coverage, type InboxItem, interrupts } from "./inbox.ts";
import { outside, pr, snapshot, ticket } from "./test-fixtures.ts";

const ids = (items: InboxItem[]) => items.map((i) => i.id);

describe("buildInbox", () => {
  test("an agent waiting or a lost terminal needs the user; the lost one comes first", () => {
    const inbox = buildInbox({
      terminals: [
        terminal({ id: "waits", agent: { sessionId: null, state: "needs_you" } }),
        terminal({ id: "lost", state: "lost", startedAt: "2026-09-30T08:00:00Z" }),
        terminal({ id: "works", agent: { sessionId: null, state: "working" } }),
      ],
    });
    expect(ids(inbox.needs)).toEqual(["lost", "waits"]);
    expect(ids(inbox.running)).toEqual(["works"]);
    expect(inbox.needs[0]).toMatchObject({ urgency: "failed", label: "perdida" });
    expect(inbox.needs[1]).toMatchObject({ urgency: "idle", label: "en espera" });
    // A finished turn still waits, but only the lost terminal interrupts.
    expect(ids(inbox.needs.filter(interrupts))).toEqual(["lost"]);
  });

  test("Claude's own word decides when the harness records no state", () => {
    const inbox = buildInbox({
      terminals: [terminal({ id: "a", activity: "busy" }), terminal({ id: "b", activity: "busy" })],
      agents: snapshot({
        app: [
          { id: "a", cpu: null, rssKb: null, lastLine: null, status: "idle", lastOutputAt: null },
          { id: "b", cpu: null, rssKb: null, lastLine: null, status: "busy", lastOutputAt: null },
        ],
      }),
    });
    expect(ids(inbox.needs)).toEqual(["a"]);
    expect(ids(inbox.running)).toEqual(["b"]);
  });

  test("a question comes before a review, a review before a finished turn", () => {
    const inbox = buildInbox({
      terminals: [
        terminal({ id: "done-turn", agent: { sessionId: null, state: "needs_you" } }),
        terminal({ id: "asks", agent: { sessionId: null, state: "needs_you" } }),
      ],
      agents: snapshot({
        app: [
          {
            id: "done-turn",
            cpu: null,
            rssKb: null,
            lastLine: null,
            status: "idle",
            lastOutputAt: null,
          },
          {
            id: "asks",
            cpu: null,
            rssKb: null,
            lastLine: null,
            status: "waiting",
            lastOutputAt: null,
          },
        ],
        outside: [outside("o", { status: "waiting" })],
      }),
      prs: [pr(7, "review")],
    });
    expect(ids(inbox.needs)).toEqual(["asks", "claude:o", "acme/api#7", "done-turn"]);
    expect(inbox.needs.map((i) => i.urgency)).toEqual(["asks", "asks", "review", "idle"]);
    expect(inbox.needs[0]).toMatchObject({ label: "esperándote" });
    expect(inbox.needs[3]).toMatchObject({ label: "en espera" });
  });

  test("an idle shell or env command asks nothing; a busy one runs; a failed one needs you", () => {
    const inbox = buildInbox({
      terminals: [
        terminal({ id: "idle", harness: "shell", activity: "idle" }),
        terminal({ id: "build", harness: "shell", activity: "busy" }),
        terminal({ id: "env", harness: "env", state: "failed" }),
      ],
    });
    expect(ids(inbox.needs)).toEqual(["env"]);
    expect(ids(inbox.running)).toEqual(["build"]);
  });

  test("an agent with no word for what it does runs; an ended one is gone", () => {
    const inbox = buildInbox({
      terminals: [
        terminal({ id: "grok", harness: "grok", activity: null }),
        terminal({ id: "done", state: "exited", endedAt: "2026-10-01T09:00:00Z" }),
      ],
    });
    expect(ids(inbox.running)).toEqual(["grok"]);
    expect(inbox.running[0]).toMatchObject({ label: "sin dato de actividad" });
    expect(inbox.needs).toEqual([]);
  });

  test("an outside session counts only while its process is proven alive", () => {
    const inbox = buildInbox({
      agents: snapshot({
        outside: [
          outside("w", { status: "waiting" }),
          outside("b", { status: "busy" }),
          outside("old", { status: "idle", state: "reciente" }),
          outside("x", { harness: "codex" }),
        ],
      }),
    });
    expect(ids(inbox.needs)).toEqual(["claude:w"]);
    expect(inbox.needs[0]).toMatchObject({ label: "esperándote" });
    expect(ids(inbox.running)).toEqual(["claude:b", "codex:x"]);
    expect(inbox.running[1]).toMatchObject({ label: "activa" });
  });

  test("a review asked of the user needs them, their own PR runs, the rest stay out", () => {
    const inbox = buildInbox({
      prs: [pr(1, "open"), pr(2, "mine"), pr(3, "review", "2026-09-30T08:00:00Z"), pr(4, "review")],
    });
    expect(ids(inbox.needs)).toEqual(["acme/api#4", "acme/api#3"]);
    expect(ids(inbox.running)).toEqual(["acme/api#2"]);
  });

  test("tickets go by Jira's status category and keep their status name", () => {
    const inbox = buildInbox({
      tickets: [ticket("A-1", "new"), ticket("A-2", "indeterminate"), ticket("A-3", "done")],
    });
    expect(ids(inbox.todo)).toEqual(["A-1"]);
    expect(ids(inbox.running)).toEqual(["A-2"]);
    const item = inbox.running[0];
    expect(item?.kind === "ticket" && item.ticket.status.name).toBe("Estado de A-2");
  });

  test("a source not read yet leaves its items out, never an error", () => {
    expect(buildInbox({})).toEqual({ needs: [], running: [], todo: [] });
  });
});

describe("coverage", () => {
  const ok = { agents: "ok", prs: "ok", tickets: "ok" } as const;

  test("a bucket is complete only when every source it reads came back whole", () => {
    const c = coverage({ ...ok, prs: "error" });
    expect(c.needs).toEqual({
      complete: false,
      gaps: [{ id: "prs", status: "error" }],
      codexBlind: false,
    });
    expect(c.running.complete).toBe(false);
    expect(c.todo).toEqual({ complete: true, gaps: [], codexBlind: false });
  });

  test("a partial or disabled source is a gap too", () => {
    const c = coverage({ ...ok, agents: "partial", tickets: "off" });
    expect(c.needs.gaps).toEqual([{ id: "agents", status: "partial" }]);
    expect(c.todo.gaps).toEqual([{ id: "tickets", status: "off" }]);
  });

  test("a running Codex keeps Te necesita from claiming it is complete", () => {
    const c = coverage(ok, [
      terminal({ id: "c", harness: "codex" }),
      terminal({ id: "x", harness: "codex", state: "exited" }),
    ]);
    expect(c.needs).toEqual({ complete: false, gaps: [], codexBlind: true });
    expect(c.running.complete).toBe(true);
    expect(coverage(ok, [terminal({ harness: "codex", state: "exited" })]).needs.complete).toBe(
      true,
    );
  });
});
