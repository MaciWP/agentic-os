import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import { SERVER_ERRORS } from "../../app-errors.ts";
import { ConfigSchema, type GithubRepo } from "../../config.ts";
import { errorHandler } from "../../errors.ts";
import { KICKOFF_KEEP_MS } from "../../retention.ts";
import type { EnvJob, JobRequest } from "../envs/jobs.ts";
import type { Env } from "../envs/provider.ts";
import type { PullInfo } from "../github/prs.ts";
import { type LaunchSpec, Listeners, type TerminalInfo } from "../terminals/contract.ts";
import type { TicketPull } from "./context.ts";
import { kickoffRoutes } from "./routes.ts";
import { type Kickoff, type KickoffDeps, Kickoffs, reviewPulls } from "./run.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "aos-kickoff-run-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const config = ConfigSchema.parse({
  jira: {
    site: "https://acme.atlassian.net",
    project: "ABC",
    boards: [
      {
        id: "sprint",
        name: "Sprint",
        columns: [
          { name: "TO DO", statuses: ["10", "11"] },
          { name: "IN PROGRESS", statuses: ["3"] },
        ],
      },
    ],
  },
  envs: { bin: "/bin/envs", root: dir, repos: ["backend", "frontend"] },
  repos: [
    { id: "backend", owner: "acme", name: "api", login: "me", localPath: "/repos/api" },
    { id: "frontend", owner: "acme", name: "web", login: "me", localPath: "/repos/web" },
  ],
});

const ticket = (status: string, assignee: unknown = null) => ({
  key: "ABC-7",
  fields: {
    summary: "Export",
    status: { id: status, name: "Por hacer", statusCategory: { key: "new", name: "x" } },
    issuetype: { name: "Tarea" },
    assignee,
    labels: [],
    updated: "2026-10-01T10:00:00.000+0200",
  },
});

type Call = { method: string; path: string; body?: unknown };

function fakeJira(
  status = "10",
  transitions: unknown = { transitions: [{ id: "31", to: { id: "3" } }] },
) {
  const calls: Call[] = [];
  const data: Record<string, unknown> = {
    "/rest/api/3/issue/ABC-7": ticket(status),
    "/rest/api/3/issue/ABC-7/comment": { comments: [] },
    "/rest/api/3/issue/ABC-7/transitions": transitions,
  };
  const jira: KickoffDeps["jira"] = {
    request: (async (schema: z.ZodType, path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        calls.push({ method, path, body: JSON.parse(String(init?.body)) });
        return schema.parse(undefined);
      }
      const found = data[path] ?? data[path.replace(/\?.*$/, "")];
      if (found instanceof Error) throw found;
      if (found === undefined) throw new Error(`no fixture for ${path}`);
      return schema.parse(found);
    }) as KickoffDeps["jira"]["request"],
    connection: () => ({ accountId: "me-1", cloudId: "c", siteUrl: "s" }),
  };
  return { jira, calls };
}

const repo = (i: number) => config.repos[i] as GithubRepo;
const pull = (i: number, number: number, mine = false): TicketPull => ({
  repo: repo(i),
  pr: {
    number,
    head: `feature/ABC-7-${number}`,
    headSha: "c0ffee1",
    body: "",
    url: `u${number}`,
  } as PullInfo,
  mine,
  comments: [],
  truncated: false,
});

const env = (name: string, servers: string): Env => ({
  name,
  branch: null,
  url: `http://${name}.localhost`,
  repos: [{ repo: "backend", branch: "x", docker: "up", servers }],
  dirs: ["api"],
  problem: null,
});

type Setup = {
  envs?: Env[][];
  jobFails?: JobRequest["action"];
  terminals?: Partial<TerminalInfo>[];
  stale?: boolean;
  prs?: { repo: string; number: number; title: string; kind: string }[];
  heads?: Record<string, string>;
  githubErrors?: string[];
  jira?: ReturnType<typeof fakeJira>;
  comments?: { author: string; created: string; body: string }[];
};

// Every fake records what it was asked; `envs` is the provider's list at each read.
function setup(s: Setup = {}) {
  const jobsRun: JobRequest[] = [];
  const launched: LaunchSpec[] = [];
  const typed: string[] = [];
  const reads = [...(s.envs ?? [[env("abc-7", "backend")]])];
  const jobMap = new Map<string, EnvJob>();
  const changes = new Listeners<[EnvJob]>();
  const { jira, calls } = s.jira ?? fakeJira();
  const deps: KickoffDeps = {
    config,
    jira,
    github: {
      list: async () =>
        ({ prs: s.prs ?? [], errors: s.githubErrors ?? [] }) as unknown as Awaited<
          ReturnType<KickoffDeps["github"]["list"]>
        >,
      pull: async (_r, n) => pull(0, n).pr,
      discussion: async () => ({ comments: s.comments ?? [], truncated: false }),
    },
    memory: {
      search: async () => [],
      phrase: async () => [],
      row: async () => null,
      get: (async () => ({ body: "Do it" })) as unknown as KickoffDeps["memory"]["get"],
      create: (async () => ({})) as unknown as KickoffDeps["memory"]["create"],
    },
    terminals: {
      list: async () => (s.terminals ?? []) as TerminalInfo[],
      create: async (spec) => {
        launched.push(spec);
        return { id: "claude-1" } as TerminalInfo;
      },
      write: async (id, data) => {
        typed.push(`${id}:${data}`);
        return true;
      },
    },
    jobs: {
      changes,
      get: (id) => jobMap.get(id) ?? null,
      start: async (req) => {
        jobsRun.push(req);
        const job = {
          id: `job-${jobsRun.length}`,
          action: req.action,
          env: null,
          state: "running",
          error: null,
          output: "",
        } as unknown as EnvJob;
        jobMap.set(job.id, job);
        // Ends after the caller starts waiting, as a real job does.
        setTimeout(() => {
          const failed = s.jobFails === req.action;
          Object.assign(
            job,
            failed
              ? { state: "failed", error: "exited with 1", output: "a\nb\nbranch exists\n" }
              : { state: "ok" },
          );
          changes.notify(job);
        }, 5);
        return job;
      },
    },
    listEnvs: async () => (reads.length > 1 ? reads.shift() : reads[0]) ?? [],
    hostInfo: async () => ({ pid: 1, stale: s.stale ?? false }),
    dataDir: dir,
    git: async (cwd, args) => (args[0] === "rev-parse" ? `${s.heads?.[cwd] ?? "aaa"}\n` : ""),
  };
  const kickoffs = new Kickoffs(deps);
  const done = (key = "ABC-7") =>
    new Promise<Kickoff>((resolve) => {
      const check = () => {
        const k = kickoffs.list().find((x) => x.key === key);
        if (k && k.state !== "running") {
          off();
          resolve(k);
        }
      };
      const off = kickoffs.changes.add(check);
      check();
    });
  return { kickoffs, done, jobsRun, launched, calls, typed };
}

describe("start", () => {
  test("a new env: created on feature/<KEY>, started, Claude in plan mode, ticket taken", async () => {
    const t = setup({ envs: [[], [env("abc-7", "stopped")], [env("abc-7", "backend")]] });
    t.kickoffs.start({ key: "ABC-7", mode: "start" });
    const k = await t.done();
    expect(k).toMatchObject({ state: "ok", step: "jira", terminal: "claude-1", warning: null });
    expect(t.jobsRun).toEqual([
      { action: "create", name: "abc-7", repos: ["backend", "frontend"], branch: "ABC-7" },
      { action: "start", name: "abc-7" },
    ]);
    expect(t.launched).toHaveLength(1);
    expect(t.launched[0]).toMatchObject({
      harness: "claude",
      location: "env:abc-7",
      ticket: "ABC-7",
      plan: true,
    });
    const contextPath = join(dir, "kickoff", "ABC-7", "start.md");
    expect(t.launched[0]?.prompt).toContain(`Read ${contextPath} first`);
    expect(t.launched[0]?.prompt).toContain("App URL: http://abc-7.localhost.");
    expect(readFileSync(contextPath, "utf8")).toContain("Summary: Export");
    expect(t.calls).toEqual([
      {
        method: "POST",
        path: "/rest/api/3/issue/ABC-7/transitions",
        body: { transition: { id: "31" } },
      },
      { method: "PUT", path: "/rest/api/3/issue/ABC-7/assignee", body: { accountId: "me-1" } },
    ]);
  });

  test("a round prunes context files past KICKOFF_KEEP_MS and the folders they empty", async () => {
    const root = join(dir, "kickoff");
    const age = (Date.now() - KICKOFF_KEEP_MS - 86_400_000) / 1000;
    const put = (path: string, old: boolean) => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), "context");
      if (old) utimesSync(join(root, path), age, age);
    };
    put("OLD-1/start.md", true);
    put("OLD-2/start.md", true);
    put("OLD-2/review.md", false);
    put("notes/start.md", true);
    // A ticket folder that is a link: what it points to is not the kickoff's.
    put("elsewhere/start.md", true);
    symlinkSync(join(root, "elsewhere"), join(root, "LNK-1"));
    const t = setup({ jira: fakeJira("3") });
    t.kickoffs.start({ key: "ABC-7", mode: "start" });
    expect(await t.done()).toMatchObject({ state: "ok" });
    expect(existsSync(join(root, "OLD-1"))).toBe(false);
    expect(existsSync(join(root, "OLD-2/start.md"))).toBe(false);
    expect(existsSync(join(root, "OLD-2/review.md"))).toBe(true);
    // Only folders named by a ticket key are the kickoff's.
    expect(existsSync(join(root, "notes/start.md"))).toBe(true);
    expect(existsSync(join(root, "elsewhere/start.md"))).toBe(true);
    expect(existsSync(join(root, "ABC-7/start.md"))).toBe(true);
  });

  test("an env already up is reused as it is: no job runs", async () => {
    const t = setup({ jira: fakeJira("3") });
    t.kickoffs.start({ key: "ABC-7", mode: "start" });
    expect(await t.done()).toMatchObject({ state: "ok", terminal: "claude-1" });
    expect(t.jobsRun).toEqual([]);
    // In progress already: only the assignment.
    expect(t.calls.map((c) => c.method)).toEqual(["PUT"]);
  });

  test("Claude already on the ticket in its env: focused, nothing else runs", async () => {
    const t = setup({
      terminals: [
        {
          id: "old",
          harness: "claude",
          ticket: "ABC-7",
          state: "running",
          location: "env:abc-7/api",
        },
      ],
    });
    t.kickoffs.start({ key: "ABC-7", mode: "start" });
    expect(await t.done()).toMatchObject({ state: "ok", terminal: "old", reused: true });
    expect(t.launched).toEqual([]);
    expect(t.calls).toEqual([]);
  });

  test("a failed create stops the chain with the provider's words; Claude never starts", async () => {
    const t = setup({ envs: [[]], jobFails: "create" });
    t.kickoffs.start({ key: "ABC-7", mode: "start" });
    const k = await t.done();
    expect(k).toMatchObject({ state: "failed", step: "env", job: "job-1" });
    expect(k.error).toBe("create falló (exited with 1): a · b · branch exists");
    expect(t.launched).toEqual([]);
    expect(t.calls).toEqual([]);
  });

  test("services still half down after the start: failed, no Claude", async () => {
    const t = setup({ envs: [[env("abc-7", "stopped")], [env("abc-7", "stopped")]] });
    t.kickoffs.start({ key: "ABC-7", mode: "start" });
    const k = await t.done();
    expect(k.state).toBe("failed");
    expect(k.error).toContain("servicios a medias en abc-7: backend stopped");
    expect(t.launched).toEqual([]);
  });

  test("an old PTY host refuses before anything runs", async () => {
    const t = setup({ stale: true });
    t.kickoffs.start({ key: "ABC-7", mode: "start" });
    expect((await t.done()).error).toContain("start-agentic-os.command");
    expect(t.jobsRun).toEqual([]);
    expect(t.launched).toEqual([]);
  });

  test("Jira refusing the move is a warning: Claude keeps working", async () => {
    const t = setup({ jira: fakeJira("10", { transitions: [] }) });
    t.kickoffs.start({ key: "ABC-7", mode: "start" });
    const k = await t.done();
    expect(k).toMatchObject({ state: "ok", terminal: "claude-1" });
    expect(k.warning).toBe("Jira: ABC-7 has no transition to status 3");
  });

  test("GitHub unread: the start goes on and its context says so, never «no PRs»", async () => {
    const t = setup({ githubErrors: ["acme/api: gh 502"] });
    t.kickoffs.start({ key: "ABC-7", mode: "start" });
    expect(await t.done()).toMatchObject({ state: "ok", terminal: "claude-1" });
    expect(readFileSync(join(dir, "kickoff", "ABC-7", "start.md"), "utf8")).toContain(
      "## Pull requests\n\n(could not read: GitHub: acme/api: gh 502)",
    );
  });

  test("one chain per ticket at a time", async () => {
    const t = setup();
    t.kickoffs.start({ key: "ABC-7", mode: "start" });
    expect(() => t.kickoffs.start({ key: "ABC-7", mode: "review" })).toThrow("ya está arrancando");
    await t.done();
    expect(() => t.kickoffs.start({ key: "ABC-7", mode: "start" })).not.toThrow();
    await t.done();
  });
});

describe("review", () => {
  const prs = [
    { repo: "backend", number: 4, title: "ABC-7 api", kind: "review" },
    { repo: "frontend", number: 5, title: "ABC-7 web", kind: "mine" },
  ];

  test("an env on the PRs' own branches, Claude in bypass with each checkout's commit", async () => {
    const envDir = join(dir, "rev-abc-7", "api");
    const t = setup({
      prs,
      envs: [[], [env("rev-abc-7", "backend")]],
      heads: { [envDir]: "c0ffee1" },
    });
    t.kickoffs.start({ key: "ABC-7", mode: "review" });
    expect(await t.done()).toMatchObject({ state: "ok", step: "agent", terminal: "claude-1" });
    expect(t.jobsRun).toEqual([
      {
        action: "create",
        name: "rev-abc-7",
        repos: ["backend", "frontend"],
        branch: "ABC-7",
        branches: { backend: "feature/ABC-7-4" },
      },
    ]);
    expect(t.launched[0]).toMatchObject({ location: "env:rev-abc-7", plan: false });
    expect(t.launched[0]?.prompt).toContain("PR heads: api #4 at c0ffee1.");
    expect(t.calls).toEqual([]);
  });

  test("GitHub unread: a review stops, since its PRs are the work", async () => {
    const t = setup({ prs, githubErrors: ["acme/api: gh 502"] });
    t.kickoffs.start({ key: "ABC-7", mode: "review" });
    const k = await t.done();
    expect(k).toMatchObject({ state: "failed", step: "context" });
    expect(k.error).toBe("GitHub: acme/api: gh 502");
    expect(t.jobsRun).toEqual([]);
  });

  test("a reused env behind the PR still launches; the header tells Claude to catch up", async () => {
    const envDir = join(dir, "rev-abc-7", "api");
    const t = setup({
      prs,
      envs: [[env("rev-abc-7", "backend")]],
      heads: { [envDir]: "1111111aa" },
    });
    t.kickoffs.start({ key: "ABC-7", mode: "review" });
    expect(await t.done()).toMatchObject({ state: "ok", terminal: "claude-1" });
    expect(t.jobsRun).toEqual([]);
    expect(t.launched[0]?.prompt).toContain(
      "api #4 at c0ffee1 (checkout at 1111111: bring it to the PR's head first)",
    );
  });

  // A review Claude still open on the ticket in its env, waiting for the user.
  const open = (agent: TerminalInfo["agent"] = { sessionId: "s", state: "needs_you" }) => ({
    id: "old",
    harness: "claude" as const,
    ticket: "ABC-7",
    state: "running" as const,
    location: "env:rev-abc-7",
    startedAt: "2026-10-01T00:00:00Z",
    agent,
  });

  test("clicked again with new commits: only what changed goes to the open Claude", async () => {
    const envDir = join(dir, "rev-abc-7", "api");
    const t = setup({
      prs,
      terminals: [open()],
      heads: { [envDir]: "1111111aa" },
      comments: [{ author: "ana", created: "2000-01-01T00:00:00Z", body: "old" }],
    });
    t.kickoffs.start({ key: "ABC-7", mode: "review" });
    expect(await t.done()).toMatchObject({
      state: "ok",
      terminal: "old",
      reused: true,
      sent: true,
    });
    expect(t.launched).toEqual([]);
    expect(t.jobsRun).toEqual([]);
    expect(t.typed).toHaveLength(2);
    expect(t.typed[0]).toContain("old:Kickoff, new review round for ABC-7");
    expect(t.typed[0]).toContain("- api #4: new commits 1111111..c0ffee1.");
    expect(t.typed[0]).not.toContain("new PR comments");
    expect(t.typed[1]).toBe("old:\r");
  });

  test("a new PR comment alone is a round too; nothing new sends nothing", async () => {
    const envDir = join(dir, "rev-abc-7", "api");
    const now = new Date(Date.now() + 60_000).toISOString();
    const comment = setup({
      prs,
      terminals: [open()],
      heads: { [envDir]: "c0ffee1" },
      comments: [{ author: "ana", created: now, body: "fixed" }],
    });
    comment.kickoffs.start({ key: "ABC-7", mode: "review" });
    expect(await comment.done()).toMatchObject({ sent: true });
    expect(comment.typed[0]).toContain("- 1 new PR comments since");

    const same = setup({ prs, terminals: [open()], heads: { [envDir]: "c0ffee1" } });
    same.kickoffs.start({ key: "ABC-7", mode: "review" });
    expect(await same.done()).toMatchObject({ state: "ok", reused: true, sent: false });
    expect(same.typed).toEqual([]);
  });

  test("the open Claude busy or asking: nothing is pasted, the panel says why", async () => {
    const envDir = join(dir, "rev-abc-7", "api");
    for (const agent of [
      { sessionId: "s", state: "working" as const },
      { sessionId: "s", state: "needs_you" as const, asks: "permission" as const },
    ]) {
      const t = setup({ prs, terminals: [open(agent)], heads: { [envDir]: "1111111aa" } });
      t.kickoffs.start({ key: "ABC-7", mode: "review" });
      const k = await t.done();
      expect(k).toMatchObject({ state: "failed", terminal: "old" });
      expect(k.error).toContain("Claude está ocupado");
      expect(t.typed).toEqual([]);
    }
  });
});

describe("reviewPulls", () => {
  test("others' PRs only, the chosen ones when given, one per known repo", () => {
    const all = [pull(0, 4), pull(1, 5, true), pull(1, 6)];
    expect(reviewPulls(all, undefined, ["backend", "frontend"]).map((p) => p.pr.number)).toEqual([
      4, 6,
    ]);
    expect(
      reviewPulls(all, [{ repo: "frontend", number: 6 }], ["backend", "frontend"]).map(
        (p) => p.pr.number,
      ),
    ).toEqual([6]);
    expect(() => reviewPulls([pull(1, 5, true)], undefined, ["frontend"])).toThrow(
      "no tiene PRs abiertas de otros",
    );
    expect(() => reviewPulls([pull(0, 4), pull(0, 8)], undefined, ["backend"])).toThrow(
      "hay dos PRs en backend",
    );
    expect(() => reviewPulls([pull(1, 6)], undefined, ["backend"])).toThrow("no conoce frontend");
  });
});

describe("routes", () => {
  const post = (app: ReturnType<typeof kickoffRoutes>, body: unknown) =>
    app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("a bad key is a 400; a second click while running is a 409; the list shows it", async () => {
    const t = setup();
    const app = kickoffRoutes(t.kickoffs).onError(errorHandler(SERVER_ERRORS));
    expect((await post(app, { key: "--yes", mode: "start" })).status).toBe(400);
    expect((await post(app, { key: "ABC-7", mode: "start" })).status).toBe(202);
    const busy = await post(app, { key: "ABC-7", mode: "start" });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: "busy" });
    await t.done();
    const listed = (await (await app.request("/")).json()) as { kickoffs: Kickoff[] };
    expect(listed.kickoffs.map((k) => [k.key, k.state])).toEqual([["ABC-7", "ok"]]);
  });
});
