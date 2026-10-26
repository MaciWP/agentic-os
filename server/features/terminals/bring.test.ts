import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../app.ts";
import { ConfigSchema } from "../../config.ts";
import { openDb } from "../../db.ts";
import type { GithubClient } from "../github/prs.ts";
import * as jiraIssues from "../jira/issues.ts";
import type { PasteMode, TerminalInfo, Terminals } from "./contract.ts";
import { MAX_PROMPT_BYTES } from "./harness.ts";
import { MAX_BRING_BYTES } from "./ticket-prompt.ts";
import { AttachTokens } from "./ws-guard.ts";

const info = (over: Partial<TerminalInfo>): TerminalInfo => ({
  id: "t",
  harness: "shell",
  location: "app",
  cwd: "/work",
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
  activity: "idle",
  lastOutputAt: null,
  pid: null,
  startedAt: "2026-10-03T10:00:00Z",
  endedAt: null,
  ...over,
});

describe("bring a ticket or a PR to a terminal", () => {
  const dir = mkdtempSync(join(tmpdir(), "aos-bring-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const list = [
    info({ id: "sh" }),
    info({ id: "cl", harness: "claude" }),
    info({ id: "env", harness: "env" }),
    info({ id: "done", state: "exited" }),
  ];
  const writes: { id: string; data: string; paste?: PasteMode }[] = [];
  // A program without bracketed paste refuses "only", as the PTY host does.
  let pasting = true;
  const terminals = {
    subscribe: () => () => {},
    list: () => list,
    get: (id: string) => list.find((t) => t.id === id),
    write: (id: string, data: string, { paste }: { paste?: PasteMode } = {}) => {
      if (paste === "only" && !pasting) return false;
      writes.push({ id, data, paste });
      return true;
    },
  } as unknown as Terminals;
  const github = {
    list: async () => ({ prs: [], errors: [] }),
    pull: async (_repo: unknown, n: number) => ({
      number: n,
      title: "Arregla login\u001b[2J",
      url: `https://github.com/acme/api/pull/${n}`,
      author: "ana",
      head: "feat/x",
      base: "dev",
      open: n !== 9,
      body: "Cambia el login.",
      draft: false,
      labels: ["auth"],
      changes: { files: 3, additions: 40, deletions: 2 },
    }),
    discussion: async () => ({
      comments: [
        { author: "luis", created: "2026-10-01T09:00:00Z", body: "¿Y el logout?" },
        {
          author: "ana",
          created: "2026-10-02T10:30:00Z",
          body: "Hecho\u001b[2J",
          where: "src/login.ts:12",
        },
      ],
      truncated: false,
    }),
  } as unknown as GithubClient;
  const repos = [
    { id: "api", owner: "acme", name: "api", login: "me", localPath: dir },
    { id: "local", localPath: dir },
  ];
  const appWith = (config: unknown) =>
    createApp({
      config: ConfigSchema.parse(config),
      db: openDb(":memory:"),
      terminals,
      tokens: new AttachTokens(),
      github,
      memoryRoots: { home: join(dir, "home"), dataDir: join(dir, "data"), repos: [] },
      pastesDir: join(dir, "pastes"),
    });
  const app = appWith({ repos });
  const withJira = appWith({
    repos,
    jira: { site: "https://example.atlassian.net/", project: "ABC" },
  });
  const bring = (id: string, body: unknown, origin = "http://127.0.0.1:4317", to = app) =>
    to.request(`/api/terminals/${id}/bring`, {
      method: "POST",
      headers: { host: "127.0.0.1:4317", origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("a shell gets one line and an agent the PR's content, neither followed by Enter", async () => {
    writes.length = 0;
    expect((await bring("sh", { ticket: "ABC-12" })).status).toBe(200);
    expect((await bring("sh", { pr: { repo: "api", number: 7 } })).status).toBe(200);
    const res = await bring("cl", { pr: { repo: "api", number: 7 } });
    expect(await res.json()).toMatchObject({ sent: true });
    expect(writes.map((w) => [w.id, w.paste])).toEqual([
      ["sh", true],
      ["sh", true],
      ["cl", "only"],
    ]);
    // Without Jira there is no link to give, only the key.
    expect(writes[0]?.data).toBe("ABC-12");
    expect(writes[1]?.data).toBe("acme/api#7 https://github.com/acme/api/pull/7");
    const prompt = writes[2]?.data ?? "";
    expect(prompt).toStartWith(
      "Context: GitHub pull request acme/api#7.\nURL: https://github.com/acme/api/pull/7\n",
    );
    // Content only: no task, no review steps, no commands to run.
    expect(prompt).not.toMatch(/Review|Look for bugs|gh pr|Do not/);
    expect(prompt).toEndWith("</pr>");
    // GitHub's text arrives quoted and without its control characters, discussion included.
    expect(prompt).toContain("Title: Arregla login[2J");
    expect(prompt).toContain(
      "Labels: auth\nChanges: 3 files, +40 -2\n\nDescription:\nCambia el login.",
    );
    expect(prompt).toContain(
      "Comments (2, oldest first):\n\n[luis · 2026-10-01 09:00]\n¿Y el logout?\n\n[ana · 2026-10-02 10:30 · src/login.ts:12]\nHecho[2J\n</pr>",
    );
    for (const w of writes) expect(w.data.includes("\r") || w.data.includes("\u001b")).toBe(false);
    expect(writes.slice(0, 2).every((w) => !w.data.includes("\n"))).toBe(true);

    // With the task, the review prompt a launch would give.
    expect((await bring("cl", { pr: { repo: "api", number: 7 }, task: "review" })).status).toBe(
      200,
    );
    expect(writes[3]?.data).toStartWith("Review GitHub pull request acme/api#7.");
    expect(writes[3]?.data).toContain("Look for bugs");
  });

  test("with Jira, a shell gets the key and its link on one line", async () => {
    writes.length = 0;
    expect((await bring("sh", { ticket: "ABC-12" }, undefined, withJira)).status).toBe(200);
    expect(writes).toEqual([
      { id: "sh", data: "ABC-12 https://example.atlassian.net/browse/ABC-12", paste: true },
    ]);
  });

  test("a ticket reaches an agent as content alone, or with the task asked; a shell gets one line", async () => {
    const issue = spyOn(jiraIssues, "getIssue").mockResolvedValue({
      key: "ABC-12",
      summary: "Export rows",
      status: { id: "20004", name: "Pull Request", category: "indeterminate" },
      issuetype: "Task",
      assignee: { accountId: "ana", displayName: "Ana" },
      parent: null,
      priority: null,
      labels: [],
      points: null,
      size: null,
      reviewers: [],
      updated: "2026-10-03T08:00:00Z",
      url: "https://example.atlassian.net/browse/ABC-12",
      descriptionAdf: null,
      descriptionMd: "Export all rows",
      acceptanceCriteria: ["All rows included"],
    });
    const comments = spyOn(jiraIssues, "getComments").mockResolvedValue([
      { author: "Ana", created: "2026-10-03T08:00:00Z", body: "Check the empty export" },
    ]);
    try {
      writes.length = 0;
      expect(
        (await bring("cl", { ticket: "ABC-12", task: "review" }, undefined, withJira)).status,
      ).toBe(200);
      expect(writes).toHaveLength(1);
      expect(writes[0]?.data).toStartWith("Review the implementation of Jira ticket ABC-12.");
      expect(writes[0]?.data).toContain("All rows included");
      expect(writes[0]?.data).toContain("Check the empty export");
      expect(writes[0]?.data).not.toContain("\r");
      expect(writes[0]?.paste).toBe("only");
      expect(issue).toHaveBeenCalledTimes(1);
      expect(comments).toHaveBeenCalledTimes(1);

      expect(
        (await bring("cl", { ticket: "ABC-12", task: "work" }, undefined, withJira)).status,
      ).toBe(200);
      expect(writes[1]?.data).toStartWith("Work on Jira ticket ABC-12.");
      expect(
        (await bring("sh", { ticket: "ABC-12", task: "review" }, undefined, withJira)).status,
      ).toBe(200);
      expect(writes[2]).toEqual({
        id: "sh",
        data: "ABC-12 https://example.atlassian.net/browse/ABC-12",
        paste: true,
      });

      // No task: the ticket and its discussion, and nothing to do.
      expect((await bring("cl", { ticket: "ABC-12" }, undefined, withJira)).status).toBe(200);
      const context = writes[3]?.data ?? "";
      expect(context).toStartWith(
        "Context: Jira ticket ABC-12.\nURL: https://example.atlassian.net/browse/ABC-12\n",
      );
      expect(context).toContain("All rows included");
      expect(context).toContain("Check the empty export");
      expect(context).toEndWith("</ticket>");
      expect(context).not.toMatch(/Work on|Review|propose a plan|Do not/);
      expect(writes[3]?.paste).toBe("only");

      writes.length = 0;
      pasting = false;
      expect(
        (await bring("cl", { ticket: "ABC-12", task: "review" }, undefined, withJira)).status,
      ).toBe(409);
      expect(writes).toHaveLength(0);
      pasting = true;
      issue.mockRejectedValueOnce(new Error("Jira unavailable"));
      expect(
        (await bring("cl", { ticket: "ABC-12", task: "review" }, undefined, withJira)).status,
      ).toBe(500);
      expect(writes).toHaveLength(0);
    } finally {
      pasting = true;
      issue.mockRestore();
      comments.mockRestore();
    }
  });

  test("«Copiar contexto» answers the text an agent gets, and refuses what it cannot read", async () => {
    const get = (query: string, to = app) =>
      to.request(`/api/terminals/context?${query}`, { headers: { host: "127.0.0.1:4317" } });
    writes.length = 0;
    const pr = await get("repo=api&number=7");
    expect(pr.status).toBe(200);
    const { text } = (await pr.json()) as { text: string };
    expect(text).toStartWith("Context: GitHub pull request acme/api#7.");
    expect(text).not.toMatch(/Review|Look for bugs|gh pr|Do not/);
    expect(writes).toHaveLength(0);
    const issue = spyOn(jiraIssues, "getIssue").mockResolvedValue({
      key: "ABC-12",
      summary: "Export rows",
      status: { id: "20004", name: "Pull Request", category: "indeterminate" },
      issuetype: "Task",
      assignee: null,
      parent: null,
      priority: null,
      labels: [],
      points: null,
      size: null,
      reviewers: [],
      updated: "2026-10-03T08:00:00Z",
      url: "https://example.atlassian.net/browse/ABC-12",
      descriptionAdf: null,
      descriptionMd: "Export all rows",
      acceptanceCriteria: [],
    });
    const comments = spyOn(jiraIssues, "getComments").mockResolvedValue([]);
    try {
      const ticket = await get("ticket=ABC-12", withJira);
      expect(((await ticket.json()) as { text: string }).text).toStartWith(
        "Context: Jira ticket ABC-12.",
      );
    } finally {
      issue.mockRestore();
      comments.mockRestore();
    }
    expect((await get("ticket=ABC-12")).status).toBe(400);
    expect((await get("repo=api&number=9")).status).toBe(400);
    expect((await get("repo=nope&number=7")).status).toBe(400);
    expect((await get("ticket=../x")).status).toBe(400);
    expect((await get("ticket=ABC-12&repo=api&number=7")).status).toBe(400);
  });

  test("content alone carries far more than a launch prompt, and stays under the bring limit", async () => {
    const issue = spyOn(jiraIssues, "getIssue").mockResolvedValue({
      key: "ABC-12",
      summary: "Export rows",
      status: { id: "3", name: "En curso", category: "indeterminate" },
      issuetype: "Task",
      assignee: null,
      parent: null,
      priority: null,
      labels: [],
      points: null,
      size: null,
      reviewers: [],
      updated: "2026-10-03T08:00:00Z",
      url: "https://example.atlassian.net/browse/ABC-12",
      descriptionAdf: null,
      descriptionMd: `${"d".repeat(12 * 1024)}END`,
      acceptanceCriteria: [],
    });
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        author: "Ana",
        created: `2026-10-03T08:${String(i % 60).padStart(2, "0")}:00Z`,
        body: `comment ${i} ${"c".repeat(1000)}`,
      }));
    const comments = spyOn(jiraIssues, "getComments").mockResolvedValue(many(20));
    try {
      writes.length = 0;
      expect((await bring("cl", { ticket: "ABC-12" }, undefined, withJira)).status).toBe(200);
      const text = writes[0]?.data ?? "";
      // A 12 KB description and 20 comments arrive whole: a launch would cut at 6 KB and 16 KB.
      expect(Buffer.byteLength(text)).toBeGreaterThan(MAX_PROMPT_BYTES);
      expect(text).toContain("END");
      expect(text).toContain("Comments (20, oldest first):");
      expect(text).not.toContain("omitted");

      comments.mockResolvedValue(many(100));
      expect((await bring("cl", { ticket: "ABC-12" }, undefined, withJira)).status).toBe(200);
      const full = writes[1]?.data ?? "";
      expect(Buffer.byteLength(full)).toBeLessThanOrEqual(MAX_BRING_BYTES);
      expect(full).toContain("older comments omitted; read them at");
      expect(full).toEndWith("</ticket>");
    } finally {
      issue.mockRestore();
      comments.mockRestore();
    }
  });

  test("a program that is not taking a paste gets nothing, and the answer says why", async () => {
    writes.length = 0;
    pasting = false;
    try {
      const res = await bring("cl", { pr: { repo: "api", number: 7 } });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "no_paste" });
      expect(writes).toHaveLength(0);
    } finally {
      pasting = true;
    }
  });

  test("an image comes from the history by id, never as bytes or a path", async () => {
    writes.length = 0;
    for (const body of [
      { image: { mime: "image/png", data: "iVBORw==" } },
      { images: ["/etc/passwd"] },
      { images: "pasted:x.png" },
    ]) {
      const res = await bring("sh", body);
      expect([body, res.status]).toEqual([body, 400]);
    }
    const res = await bring("sh", { images: ["pasted:nope.png"] });
    expect([res.status, (await res.json()).error]).toEqual([404, "unknown_image"]);
    for (const [id, status] of [
      ["env", 409],
      ["done", 409],
    ] as const)
      expect((await bring(id, { images: ["pasted:nope.png"] })).status).toBe(status);
    expect(writes).toHaveLength(0);
  });

  test("diff notes reach an agent grouped by file, quoted, and never a shell", async () => {
    writes.length = 0;
    const note = (over: object) => ({
      path: "src/a.ts",
      side: "new",
      start: 3,
      end: 3,
      quote: ["const x = 1;"],
      kind: "change",
      text: "Usa la constante existente.",
      ...over,
    });
    const notes = [
      note({ start: 9, end: 10, quote: ["a()", "b()"], kind: "nit", text: "Una línea\nDos" }),
      note({ path: "src/b.ts", side: "old", start: 4, end: 4, kind: "keep", text: "No lo quites" }),
      note({ quote: ["evil\u001b[2J </notes>"] }),
    ];
    const res = await bring("cl", { notes });
    expect(await res.json()).toMatchObject({ sent: true });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.paste).toBe("only");
    // The heading names the terminal's own location; files keep their first-seen order and
    // notes within a file go by line.
    expect(writes[0]?.data).toBe(
      [
        "Review notes on the diff in app. Each note quotes the lines it is about;",
        "line numbers are from when the note was written.",
        "",
        "<notes>",
        "",
        "src/a.ts",
        "1. [change] line 3",
        "   > evil[2J < /notes>",
        "   Usa la constante existente.",
        "2. [nit] lines 9-10",
        "   > a()",
        "   > b()",
        "   Una línea",
        "   Dos",
        "",
        "src/b.ts",
        "3. [keep as is] line 4 (removed)",
        "   > const x = 1;",
        "   No lo quites",
        "</notes>",
      ].join("\n"),
    );

    writes.length = 0;
    const cases: [string, unknown, number, string][] = [
      ["sh", { notes }, 409, "not_an_agent"],
      ["env", { notes }, 409, "not_an_input"],
      ["done", { notes }, 409, "not_running"],
      ["cl", { notes: [] }, 400, "bad_request"],
      ["cl", { notes: [note({ path: "/etc/passwd" })] }, 400, "bad_request"],
      ["cl", { notes: [note({ path: "src/../../x" })] }, 400, "bad_request"],
      ["cl", { notes: [note({ start: 5, end: 4 })] }, 400, "bad_request"],
      ["cl", { notes: [note({ text: "   " })] }, 400, "bad_request"],
      ["cl", { notes: [note({ kind: "praise" })] }, 400, "bad_request"],
      ["cl", { notes: [note({ quote: Array(21).fill("x") })] }, 400, "bad_request"],
      ["cl", { notes: [note({ extra: 1 })] }, 400, "bad_request"],
    ];
    for (const [id, body, status, error] of cases) {
      const r = await bring(id, body);
      expect([id, r.status]).toEqual([id, status]);
      expect(await r.json()).toMatchObject({ error });
    }
    // Fifty notes of full size are valid one by one but too long to paste together.
    const big = Array.from({ length: 50 }, () =>
      note({ quote: Array(20).fill("y".repeat(500)), text: "z".repeat(2000) }),
    );
    expect((await bring("cl", { notes: big })).status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  test("refusals: env commands, ended terminals, closed PRs, foreign origins, bad bodies", async () => {
    writes.length = 0;
    const cases: [string, unknown, number, string?][] = [
      ["env", { ticket: "ABC-12" }, 409, "not_an_input"],
      ["done", { ticket: "ABC-12" }, 409, "not_running"],
      ["nope", { ticket: "ABC-12" }, 404, "not_found"],
      ["cl", { pr: { repo: "api", number: 9 } }, 400, "launch_rejected"],
      ["cl", { pr: { repo: "local", number: 1 } }, 400, "launch_rejected"],
      ["cl", { pr: { repo: "gone", number: 1 } }, 400, "launch_rejected"],
      // Without a Jira section an agent has no ticket to read.
      ["cl", { ticket: "ABC-12" }, 400, "jira_not_configured"],
      ["sh", { ticket: "abc-12; rm" }, 400, "bad_request"],
      ["sh", { ticket: "ABC-12", pr: { repo: "api", number: 1 } }, 400, "bad_request"],
      ["sh", { text: "rm -rf ~" }, 400, "bad_request"],
      // The old field is gone, so it is refused rather than read as "no task".
      ["sh", { ticket: "ABC-12", intent: "review" }, 400, "bad_request"],
      ["sh", { ticket: "ABC-12", task: "merge" }, 400, "bad_request"],
      ["sh", { ticket: "ABC-12", task: null }, 400, "bad_request"],
      ["sh", { ticket: "ABC-12", task: "review", text: "extra" }, 400, "bad_request"],
      ["sh", { pr: { repo: "api", number: 7 }, task: "work" }, 400, "bad_request"],
      ["sh", { images: ["pasted:a.png"], task: "review" }, 400, "bad_request"],
      ["env", { ticket: "ABC-12", task: "review" }, 409, "not_an_input"],
      ["done", { ticket: "ABC-12", task: "review" }, 409, "not_running"],
    ];
    for (const [id, body, status, error] of cases) {
      const res = await bring(id, body);
      expect([id, res.status]).toEqual([id, status]);
      expect(await res.json()).toMatchObject({ error });
    }
    expect((await bring("sh", { ticket: "ABC-12" }, "http://evil.test")).status).toBe(403);
    expect(writes).toHaveLength(0);
  });
  describe("a work bar prompt", () => {
    const agent = (state: "working" | "needs_you" | null, asks?: "permission") => ({
      sessionId: "s",
      state,
      asks,
    });
    list.push(
      info({ id: "idle", harness: "claude", ticket: "ABC-7", agent: agent("needs_you") }),
      info({ id: "cx", harness: "codex", agent: agent("needs_you") }),
      info({ id: "busy", harness: "claude", agent: agent("working") }),
      info({ id: "asks", harness: "claude", agent: agent("needs_you", "permission") }),
      info({ id: "gk", harness: "grok", agent: null }),
    );
    const prompts = join(dir, "data", "prompts");
    mkdirSync(prompts, { recursive: true });
    writeFileSync(
      join(prompts, "review.md"),
      "---\nbar: true\n---\nReview {{ticket}} in {{location}}.\nThen report.\n",
    );
    writeFileSync(join(prompts, "short.md"), "---\nbar: true\n---\nCheck the context.\n");

    test("an agent waiting for its next message gets the filled prompt as one paste, then Enter", async () => {
      writes.length = 0;
      const res = await bring("idle", { prompt: "prompts:review.md" });
      expect(res.status).toBe(200);
      expect(writes).toEqual([
        { id: "idle", data: "Review ABC-7 in app.\nThen report.", paste: "only" },
        { id: "idle", data: "\r", paste: undefined },
      ]);
      writes.length = 0;
      expect((await bring("cx", { prompt: "prompts:short.md" })).status).toBe(200);
      expect(writes.map((w) => w.data)).toEqual(["Check the context.", "\r"]);
    });

    test("working, asking, stateless, shell and missing variables are refused, nothing typed", async () => {
      writes.length = 0;
      const cases: [string, string, number, string][] = [
        ["busy", "short", 409, "agent_busy"],
        ["asks", "short", 409, "agent_asks"],
        ["gk", "short", 409, "no_state"],
        ["cl", "short", 409, "no_state"],
        ["sh", "short", 409, "not_an_agent"],
        ["env", "short", 409, "not_an_input"],
        ["cx", "review", 409, "missing"],
      ];
      for (const [id, name, status, error] of cases) {
        const res = await bring(id, { prompt: `prompts:${name}.md` });
        expect([id, res.status]).toEqual([id, status]);
        expect(await res.json()).toMatchObject({ error });
      }
      const missing = await bring("cx", { prompt: "prompts:review.md" });
      expect(await missing.json()).toMatchObject({ detail: "{{ticket}}" });
      // Only the saved prompts folder: a note is not a button.
      expect((await bring("idle", { prompt: "notes:review.md" })).status).toBe(400);
      expect(writes).toHaveLength(0);
    });

    test("a TUI not taking pastes refuses a multi-line prompt and gets no Enter", async () => {
      writes.length = 0;
      pasting = false;
      const res = await bring("idle", { prompt: "prompts:review.md" });
      pasting = true;
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "no_paste" });
      expect(writes).toHaveLength(0);
    });
  });
});
