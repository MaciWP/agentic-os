import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../../config.ts";
import { openDb } from "../../db.ts";
import type { Services } from "../../deps.ts";
import { ProviderError } from "../../provider-error.ts";
import { USAGE_KEEP_MS } from "../../retention.ts";
import { ObjectiveStore } from "../objectives/store.ts";
import type { TerminalInfo } from "../terminals/contract.ts";
import { activityOf, SLOT_MS, SLOTS } from "./activity.ts";
import { BRIEF_TTL_MS, briefLoader } from "./briefs.ts";
import { claudeLines } from "./claude.ts";
import { type CodexState, codexLines } from "./codex.ts";
import { grokUsage } from "./grok.ts";
import { UsageIngest } from "./ingest.ts";
import { placeOf } from "./place-of.ts";
import { costOf, priceOf } from "./pricing.ts";
import { usageReport } from "./report.ts";
import { usageRoutes } from "./routes.ts";

const T = "2026-10-05T10:00:00.000Z";
const where = { sessionId: "s-1", agent: "" };

const assistant = (over: Record<string, unknown> = {}, message: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "assistant",
    timestamp: T,
    cwd: "/w/abc-1033/backend",
    gitBranch: "feature/ABC-1033-x",
    message: {
      id: "msg_1",
      model: "claude-opus-5-5",
      content: [],
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 1000,
        output_tokens: 40,
        cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 100 },
      },
      ...message,
    },
    ...over,
  });

describe("Claude transcript lines", () => {
  test("a call's tokens, with the 1h cache apart and the skill Claude attributes it to", () => {
    const out = claudeLines([assistant({ attributionSkill: "dev-workflow" })], where, {
      cwd: "",
      branch: "",
    });
    expect(out.usage).toEqual([
      {
        id: "msg_1",
        sessionId: "s-1",
        agent: "",
        cwd: "/w/abc-1033/backend",
        branch: "feature/ABC-1033-x",
        at: T,
        skill: "dev-workflow",
        model: "claude-opus-5-5",
        input: 2,
        cacheRead: 1000,
        cacheWrite: 100,
        cacheWrite1h: 200,
        output: 40,
      },
    ]);
  });

  test("an advisor call becomes its own row, and each real call keeps its own tokens", () => {
    const call = (input: number, read: number, write: number, output: number) => ({
      type: "message",
      input_tokens: input,
      cache_read_input_tokens: read,
      cache_creation_input_tokens: write,
      cache_creation: { ephemeral_1h_input_tokens: write },
      output_tokens: output,
    });
    const usage = {
      input_tokens: 4,
      cache_read_input_tokens: 2500,
      cache_creation_input_tokens: 50,
      cache_creation: { ephemeral_1h_input_tokens: 50 },
      output_tokens: 60,
      iterations: [
        call(2, 1200, 30, 10),
        {
          ...call(90_000, 0, 0, 5000),
          type: "advisor_message",
          model: "claude-opus-5-5",
        },
        call(2, 1300, 20, 50),
      ],
    };
    const out = claudeLines(
      [assistant({ advisorModel: "opus", attributionSkill: "s" }, { usage })],
      where,
      { cwd: "", branch: "" },
    );
    const rows = out.usage.map(({ id, model, input, cacheRead, cacheWrite1h, output, role }) => ({
      id,
      model,
      input,
      cacheRead,
      cacheWrite1h,
      output,
      role,
    }));
    expect(rows).toEqual([
      {
        id: "msg_1",
        model: "claude-opus-5-5",
        input: 2,
        cacheRead: 1200,
        cacheWrite1h: 30,
        output: 10,
        role: undefined,
      },
      {
        id: "msg_1:advisor:1",
        model: "claude-opus-5-5",
        input: 90_000,
        cacheRead: 0,
        cacheWrite1h: 0,
        output: 5000,
        role: "advisor",
      },
      {
        id: "msg_1:2",
        model: "claude-opus-5-5",
        input: 2,
        cacheRead: 1300,
        cacheWrite1h: 20,
        output: 50,
        role: undefined,
      },
    ]);
    // The ordinary calls add up to the message's own counts: nothing is counted twice.
    const calls = out.usage.filter((u) => !u.role);
    expect(calls.reduce((s, u) => s + u.cacheRead, 0)).toBe(usage.cache_read_input_tokens);
    expect(calls.reduce((s, u) => s + u.output, 0)).toBe(usage.output_tokens);
    expect(out.usage.every((u) => u.skill === "s")).toBe(true);
    // No level on the line: none on the rows.
    expect(out.usage.map((u) => u.effort)).toEqual([undefined, undefined, undefined]);
  });

  test("a call keeps the turn's effort level; the advisor's, run at its own, stays unsaid", () => {
    const usage = {
      input_tokens: 1,
      output_tokens: 1,
      iterations: [
        { type: "message", input_tokens: 1, output_tokens: 1 },
        { type: "advisor_message", input_tokens: 1, output_tokens: 1, model: "claude-opus-5-5" },
      ],
    };
    const read = (over: Record<string, unknown>, message: Record<string, unknown> = {}) =>
      claudeLines([assistant(over, message)], where, { cwd: "", branch: "" }).usage.map((u) => [
        u.role ?? "call",
        u.effort,
      ]);
    expect(read({ effort: "xhigh", perTurnEffort: "xhigh" }, { usage })).toEqual([
      ["call", "xhigh"],
      ["advisor", undefined],
    ]);
    // An older line with only the per-turn field; a value that is not a level is none.
    expect(read({ perTurnEffort: "medium" })).toEqual([["call", "medium"]]);
    expect(read({ effort: "<script>" })).toEqual([["call", undefined]]);
  });

  test("an advisor iteration without its own model takes the line's advisor model", () => {
    const usage = {
      input_tokens: 1,
      output_tokens: 1,
      iterations: [
        { type: "message", input_tokens: 1, output_tokens: 1 },
        { type: "advisor_message", input_tokens: 7, output_tokens: 3 },
      ],
    };
    const out = claudeLines([assistant({ advisorModel: "claude-fable-5-1" }, { usage })], where, {
      cwd: "",
      branch: "",
    });
    expect(out.usage.map((u) => [u.id, u.model])).toEqual([
      ["msg_1", "claude-opus-5-5"],
      ["msg_1:advisor:1", "claude-fable-5-1"],
    ]);
  });

  test("synthetic messages and lines of no interest are skipped", () => {
    const out = claudeLines(
      [
        assistant({}, { model: "<synthetic>" }),
        JSON.stringify({ type: "file-history-snapshot", timestamp: T }),
        "not json",
        "",
      ],
      where,
      { cwd: "", branch: "" },
    );
    expect(out).toEqual({ usage: [], events: [], drop: [], checks: [] });
  });

  test("tool calls, skills and subagents with the model asked for", () => {
    const content = [
      { type: "text", text: "hi" },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      { type: "tool_use", id: "t2", name: "Skill", input: { skill: "drillme-clarify" } },
      {
        type: "tool_use",
        id: "t3",
        name: "Agent",
        input: { subagent_type: "Explore", model: "haiku" },
      },
      { type: "tool_use", id: "t4", name: "mcp__github__get_pr", input: {} },
    ];
    const out = claudeLines([assistant({}, { content })], where, { cwd: "", branch: "" });
    expect(out.events.map((e) => [e.kind, e.name, e.detail, e.id])).toEqual([
      ["tool", "Bash", "", "t1"],
      ["tool", "Skill", "", "t2"],
      ["skill", "drillme-clarify", "", "t2"],
      ["tool", "Agent", "", "t3"],
      ["subagent", "Explore", "haiku", "t3"],
      ["tool", "mcp__github__get_pr", "", "t4"],
    ]);
  });

  test("commands typed, hooks that blocked a tool, and hooks that ran, failed or timed out", () => {
    const user = (content: unknown, uuid = "u1") =>
      JSON.stringify({ type: "user", uuid, timestamp: T, message: { role: "user", content } });
    const hook = (type: string, extra: Record<string, unknown>, uuid: string) =>
      JSON.stringify({
        type: "attachment",
        uuid,
        timestamp: T,
        attachment: { type, hookName: "PreToolUse:Bash", hookEvent: "PreToolUse", ...extra },
      });
    const out = claudeLines(
      [
        user("<command-message>x</command-message>\n<command-name>/dev-workflow</command-name>"),
        user(
          [
            {
              type: "tool_result",
              tool_use_id: "t9",
              is_error: true,
              content: "PreToolUse:Bash hook error: [security-gate] secret in a.ts",
            },
            {
              type: "tool_result",
              tool_use_id: "t8",
              is_error: true,
              content: [{ type: "text", text: "PreToolUse:Bash hook error: `cat` would dump x" }],
            },
            { type: "tool_result", tool_use_id: "t7", is_error: true, content: "plain failure" },
          ],
          "u2",
        ),
        hook(
          "hook_success",
          { command: "bun ~/.claude/hooks/skill-activation.ts", durationMs: 12.4 },
          "h1",
        ),
        hook(
          "hook_non_blocking_error",
          { stderr: "/bin/sh: .claude/hooks/graphify-nudge.sh: No such file", durationMs: 9 },
          "h2",
        ),
        hook("hook_cancelled", { command: "bun x/bash-output-shaper.ts", durationMs: 5764 }, "h3"),
        hook("hook_additional_context", {}, "h4"),
      ],
      where,
      { cwd: "/w", branch: "main" },
    );
    expect(out.events.map((e) => [e.kind, e.name, e.detail, e.ms, e.id])).toEqual([
      ["command", "/dev-workflow", "", null, "u1"],
      ["hook", "security-gate", "block", null, "t9:hook"],
      ["hook", "PreToolUse:Bash", "block", null, "t8:hook"],
      ["hook", "skill-activation.ts", "ok", 12, "h1"],
      ["hook", "graphify-nudge.sh", "error", 9, "h2"],
      ["hook", "bash-output-shaper.ts", "timeout", 5764, "h3"],
    ]);
    // Lines without cwd or branch keep the last ones seen.
    expect(out.events.every((e) => e.cwd === "/w" && e.branch === "main")).toBe(true);
  });

  test("a long hook command is read in linear time", () => {
    const command = `${"a".repeat(200_000)} ; bun /h/check.ts`;
    const line = JSON.stringify({
      type: "attachment",
      uuid: "h",
      timestamp: T,
      attachment: { type: "hook_success", hookName: "Stop", command },
    });
    const started = performance.now();
    const out = claudeLines([line], where, { cwd: "", branch: "" });
    expect(performance.now() - started).toBeLessThan(500);
    expect(out.events[0]?.name).toBe("check.ts");
  });
});

describe("Codex rollout lines", () => {
  const state = (): CodexState => ({
    sessionId: "",
    cwd: "",
    branch: "",
    model: "",
    records: false,
  });
  const line = (type: string, payload: Record<string, unknown>, at = T) =>
    JSON.stringify({ timestamp: at, type, payload });
  const meta = line("session_meta", { id: "c-1", cwd: "/w", git: { branch: "ABC-7" } });
  const turn = line("turn_context", { model: "gpt-6-astra", cwd: "/w" });
  const tokens = { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 };

  test("per-response records, with the cache taken out of the input", () => {
    const s = state();
    const out = codexLines(
      [
        meta,
        turn,
        line("token_usage_record", { response_id: "r1", usage: tokens }),
        line("event_msg", { type: "token_count", info: { total_token_usage: tokens } }),
        line("response_item", { type: "function_call", name: "exec", call_id: "call_1" }),
        line("response_item", { type: "function_call_output", call_id: "call_1" }),
      ],
      s,
    );
    expect(out.usage.map((u) => [u.id, u.model, u.input, u.cacheRead, u.output, u.branch])).toEqual(
      [["r1", "gpt-6-astra", 200, 800, 50, "ABC-7"]],
    );
    expect(out.drop).toEqual(["c-1:total"]);
    expect(out.events.map((e) => [e.kind, e.name, e.id])).toEqual([["tool", "exec", "call_1"]]);
    expect(s.records).toBe(true);
  });

  test("older rollouts give one running total, replaced as it grows", () => {
    const s = state();
    const total = (n: number) =>
      line("event_msg", {
        type: "token_count",
        info: { total_token_usage: { input_tokens: n, cached_input_tokens: 0, output_tokens: 1 } },
      });
    const out = codexLines([meta, turn, total(10), total(30)], s);
    expect(out.usage.map((u) => [u.id, u.input])).toEqual([
      ["c-1:total", 10],
      ["c-1:total", 30],
    ]);
  });

  test("nothing counts before the session's header", () => {
    expect(
      codexLines([line("token_usage_record", { response_id: "r", usage: tokens })], state()).usage,
    ).toEqual([]);
  });
});

test("Grok's usage report becomes one row per turn and model", () => {
  const rows = grokUsage(
    {
      sessionId: "g-1",
      turns: [
        {
          turnNumber: 1,
          endedAt: T,
          modelUsage: {
            "grok-4.7-build": { inputTokens: 100, cachedReadTokens: 60, outputTokens: 5 },
          },
        },
      ],
    },
    { cwd: "/w", at: "2026-01-01T00:00:00.000Z" },
  );
  expect(rows.map((r) => [r.id, r.input, r.cacheRead, r.output, r.at])).toEqual([
    ["g-1:1:grok-4.7-build", 40, 60, 5, T],
  ]);
});

describe("UsageIngest", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "aos-usage-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const count = (db: ReturnType<typeof openDb>, q: string) =>
    (db.query(q).get() as { n: number }).n;

  test("reads only what is new, never a half-written line, and never counts a call twice", async () => {
    const dir = join(home, ".claude", "projects", "-w");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "s-1.jsonl");
    // One message spread over two lines with the same id.
    writeFileSync(file, `${assistant()}\n${assistant()}\n`);
    const db = openDb(":memory:");
    const ingest = new UsageIngest({ db, home, grokUsage: null });
    await ingest.run();
    expect(count(db, "SELECT count(*) AS n FROM agent_usage")).toBe(1);
    const half = assistant({}, { id: "msg_2" });
    appendFileSync(file, half.slice(0, 40));
    await ingest.run();
    expect(count(db, "SELECT count(*) AS n FROM agent_usage")).toBe(1);
    appendFileSync(file, `${half.slice(40)}\n`);
    await ingest.run();
    expect(count(db, "SELECT count(*) AS n FROM agent_usage")).toBe(2);
    // Rewritten shorter: read again from the start, still two calls.
    writeFileSync(file, `${assistant({}, { id: "msg_2" })}\n`);
    await ingest.run();
    expect(count(db, "SELECT count(*) AS n FROM agent_usage")).toBe(2);
    expect(count(db, "SELECT sum(output) AS n FROM agent_usage")).toBe(80);
  });

  test("a read with advisor calls replaces the summed row an older read wrote", async () => {
    const dir = join(home, ".claude", "projects", "-w");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "s-1.jsonl");
    const db = openDb(":memory:");
    const ingest = new UsageIngest({ db, home, grokUsage: null });
    // What an older read stored: the message's summed counts under its id.
    writeFileSync(file, `${assistant({}, { usage: { input_tokens: 4, output_tokens: 60 } })}\n`);
    await ingest.run();
    const usage = {
      input_tokens: 4,
      output_tokens: 60,
      iterations: [
        { type: "message", input_tokens: 2, output_tokens: 10 },
        { type: "advisor_message", input_tokens: 900, output_tokens: 70, model: "claude-opus-5-5" },
        { type: "message", input_tokens: 2, output_tokens: 50 },
      ],
    };
    writeFileSync(file, `${assistant({}, { usage })}\n`);
    db.exec("DELETE FROM agent_sources");
    await ingest.run();
    expect(
      db
        .query(
          "SELECT role, count(*) AS calls, sum(output) AS output FROM agent_usage GROUP BY role ORDER BY role",
        )
        .all(),
    ).toEqual([
      { role: "advisor", calls: 1, output: 70 },
      { role: "call", calls: 2, output: 60 },
    ]);
  });

  test("a subagent's calls go to its session under its type; Grok with no usage is no error", async () => {
    const sub = join(home, ".claude", "projects", "-w", "s-1", "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "agent-a1.jsonl"), `${assistant({}, { id: "msg_s" })}\n`);
    writeFileSync(join(sub, "agent-a1.meta.json"), JSON.stringify({ agentType: "Explore" }));
    const grok = join(home, ".grok", "sessions", encodeURIComponent("/w/x"), "g-1");
    mkdirSync(grok, { recursive: true });
    writeFileSync(
      join(grok, "events.jsonl"),
      `${JSON.stringify({ ts: T, type: "tool_started", tool_name: "list_dir" })}\n`,
    );
    const db = openDb(":memory:");
    const asked: string[] = [];
    const run = await new UsageIngest({
      db,
      home,
      grokUsage: async (id) => {
        asked.push(id);
        return null;
      },
    }).run();
    expect(run.errors).toEqual([]);
    expect(asked).toEqual(["g-1"]);
    expect(db.query("SELECT session_id, agent FROM agent_usage").all()).toEqual([
      { session_id: "s-1", agent: "Explore" },
    ]);
    expect(
      db
        .query("SELECT a.name, p.cwd FROM agent_events a JOIN agent_places p ON p.id = a.place_id")
        .all(),
    ).toEqual([{ name: "list_dir", cwd: "/w/x" }]);
  });

  test("a Workflow run's agents are read once, under their type", async () => {
    const run = join(home, ".claude", "projects", "-w", "s-2", "subagents", "workflows", "wf_1");
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, "agent-b1.jsonl"), `${assistant({}, { id: "msg_w" })}\n`);
    writeFileSync(
      join(run, "agent-b1.meta.json"),
      JSON.stringify({ agentType: "workflow-subagent", model: "sonnet" }),
    );
    const db = openDb(":memory:");
    const ingest = new UsageIngest({ db, home, grokUsage: async () => null });
    expect((await ingest.run()).errors).toEqual([]);
    await ingest.run();
    expect(
      db.query("SELECT session_id, agent FROM agent_usage WHERE session_id = 's-2'").all(),
    ).toEqual([{ session_id: "s-2", agent: "workflow-subagent" }]);
  });

  test("calls and events past the retention window leave; a read file is not read again", async () => {
    const dir = join(home, ".claude", "projects", "-w");
    mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - USAGE_KEEP_MS - 86_400_000).toISOString();
    writeFileSync(
      join(dir, "s-1.jsonl"),
      `${assistant({ timestamp: old }, { id: "msg_old" })}\n${assistant()}\n`,
    );
    const db = openDb(":memory:");
    db.run("INSERT INTO agent_places (id, cwd, branch) VALUES (99, '/w', '')");
    db.run(
      `INSERT INTO agent_events (harness, id, kind, session_id, place_id, name, at)
       VALUES ('claude', 'e-old', 'tool', 's-0', 99, 'Read', ?), ('claude', 'e-new', 'tool', 's-0', 99, 'Read', ?)`,
      [old, T],
    );
    // The offset of a transcript deleted since: nothing can read it again.
    db.run(
      "INSERT INTO agent_sources (path, harness, session_id, read_bytes, size, mtime) VALUES (?, 'claude', 's-9', 1, 1, 1)",
      [join(dir, "gone.jsonl")],
    );
    const ingest = new UsageIngest({ db, home, grokUsage: null });
    await ingest.run();
    const ids = (table: string) =>
      db
        .query<{ id: string }, []>(`SELECT id FROM ${table} ORDER BY id`)
        .all()
        .map((r) => r.id);
    expect(ids("agent_usage")).toEqual(["msg_1"]);
    expect(ids("agent_events")).toEqual(["e-new"]);
    expect(
      db
        .query<{ path: string }, []>("SELECT path FROM agent_sources")
        .all()
        .map((r) => r.path),
    ).toEqual([join(dir, "s-1.jsonl")]);
    // The file is unchanged: its offset stays, so the pruned call never comes back.
    await ingest.run();
    expect(ids("agent_usage")).toEqual(["msg_1"]);
  });

  test("a place no call or event cites leaves; a later call there gets one again", async () => {
    const dir = join(home, ".claude", "projects", "-w");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "s-1.jsonl");
    const old = new Date(Date.now() - USAGE_KEEP_MS - 86_400_000).toISOString();
    writeFileSync(file, `${assistant({ timestamp: old }, { id: "msg_old" })}\n`);
    const db = openDb(":memory:");
    db.run("INSERT INTO agent_places (id, cwd, branch) VALUES (99, '/kept', '')");
    db.run(
      `INSERT INTO agent_events (harness, id, kind, session_id, place_id, name, at)
       VALUES ('claude', 'e-new', 'tool', 's-0', 99, 'Read', ?)`,
      [T],
    );
    const places = () =>
      db
        .query<{ cwd: string }, []>("SELECT cwd FROM agent_places ORDER BY cwd")
        .all()
        .map((r) => r.cwd);
    const ingest = new UsageIngest({ db, home, grokUsage: null });
    await ingest.run();
    expect(places()).toEqual(["/kept"]);
    // The same folder again: the place it had is gone, so it is written anew.
    appendFileSync(file, `${assistant()}\n`);
    expect((await ingest.run()).errors).toEqual([]);
    expect(places()).toEqual(["/kept", "/w/abc-1033/backend"]);
    expect(count(db, "SELECT count(*) n FROM agent_usage")).toBe(1);
  });
});

describe("report", () => {
  const config = ConfigSchema.parse({
    jira: { site: "https://x.atlassian.net", project: "ABC" },
    envs: { bin: "/bin/echo", root: "/w", repos: ["backend"] },
    repos: [{ id: "app", localPath: "/r/app" }],
    pricing: {
      "claude-opus": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, cacheWrite1h: 20 },
      "claude-opus-5-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    },
  });

  test("the ticket key is the configured project's, bounded, in any case", () => {
    expect(placeOf(config, "/w/abc-1033/backend", "main")).toEqual({
      ticket: "ABC-1033",
      location: "abc-1033",
    });
    expect(placeOf(config, "/r/app", "feature/ABC-10-fix").ticket).toBe("ABC-10");
    expect(placeOf(config, "/r/app", "ABC-1033").ticket).toBe("ABC-1033");
    expect(placeOf(config, "/r/app", "XABC-10").ticket).toBeNull();
    expect(placeOf(config, "/r/app/src", "XYZ-12")).toEqual({ ticket: null, location: "app" });
    expect(placeOf(config, "/elsewhere/tool", "").location).toBe("tool");
    expect(placeOf(ConfigSchema.parse({}), "/w/abc-1/x", "ABC-1").ticket).toBeNull();
  });

  test("a folder outside the configured places counts under its git checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "aos-usage-"));
    try {
      mkdirSync(join(root, "tool", ".git"), { recursive: true });
      mkdirSync(join(root, "tool", "src", "hooks"), { recursive: true });
      mkdirSync(join(root, "loose"));
      expect(placeOf(config, join(root, "tool", "src", "hooks"), "").location).toBe("tool");
      expect(placeOf(config, join(root, "loose"), "").location).toBe("loose");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the longest configured prefix prices a model; 1h writes fall back to the 5m price", () => {
    expect(priceOf(config.pricing, "claude-opus-5-5")?.input).toBe(5);
    expect(priceOf(config.pricing, "claude-opus-5")?.input).toBe(10);
    expect(priceOf(config.pricing, "gpt-6")).toBeNull();
    const t = { input: 1e6, cache_read: 1e6, cache_write: 1e6, cache_write_1h: 1e6, output: 1e6 };
    expect(costOf({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, t)).toBe(1 + 2 + 3 + 4 + 4);
  });

  test("a prompt over 100K bills the whole call at the long rates, and each role adds up apart", async () => {
    const haiku = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 };
    const long = { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 };
    const priced = ConfigSchema.parse({
      jira: { site: "https://x.atlassian.net", project: "ABC" },
      pricing: { "claude-haiku-5-5": { ...haiku, over100k: long }, "claude-opus-5-5": haiku },
    });
    expect(priceOf(priced.pricing, "claude-haiku-5-5", true)).toEqual(long);
    expect(priceOf(priced.pricing, "claude-opus-5-5", true)).toEqual(haiku);
    const db = openDb(":memory:");
    db.query("INSERT INTO agent_places (id, cwd, branch) VALUES (1, '/r/x', '')").run();
    const insert = db.query(
      `INSERT INTO agent_usage (harness, id, session_id, place_id, agent, skill, model, at,
         input, cache_read, cache_write, cache_write_1h, output, role)
       VALUES ('claude', ?, 's-1', 1, ?, '', ?, ?, ?, ?, 0, 0, 1000, ?)`,
    );
    // A Lead call, a 90K and a 120K subagent call (exactly 100K stays at the base rate), and
    // an advisor call.
    insert.run("m1", "", "claude-opus-5-5", T, 10, 1000, "call");
    insert.run("m2", "Explore", "claude-haiku-5-5", T, 10_000, 80_000, "call");
    insert.run("m3", "Explore", "claude-haiku-5-5", T, 20_000, 100_000, "call");
    insert.run("m4", "Explore", "claude-haiku-5-5", T, 0, 100_000, "call");
    insert.run("m5", "", "claude-opus-5-5", T, 90_000, 0, "advisor");
    const r = await usageReport(db, priced, { from: "2026-10-05", to: "2026-10-05" });
    const at = (rates: typeof haiku, input: number, read: number) =>
      (input * rates.input + read * rates.cacheRead + 1000 * rates.output) / 1e6;
    const sub = at(haiku, 10_000, 80_000) + at(long, 20_000, 100_000) + at(haiku, 0, 100_000);
    expect(r.byRole.map((l) => [l.key, l.calls, l.longCalls])).toEqual([
      ["subagent", 3, 1],
      ["advisor", 1, 0],
      ["lead", 1, 0],
    ]);
    expect(r.byRole[0]?.cost).toBeCloseTo(sub, 12);
    expect(r.byRole[1]?.cost).toBeCloseTo(at(haiku, 90_000, 0), 12);
    expect(r.total.longCalls).toBe(1);
    // Model by role: the advisor's model counts under the advisor, not under the session.
    expect(r.byModelRole.map((l) => [l.key, l.calls]).sort()).toEqual([
      ["advisor|claude-opus-5-5", 1],
      ["lead|claude-opus-5-5", 1],
      ["subagent|claude-haiku-5-5", 3],
    ]);
    expect(r.byModelRole.reduce((n, l) => n + (l.cost ?? 0), 0)).toBeCloseTo(r.total.cost ?? 0, 12);
    // Repriced: the same tokens at another model's price, its long rate only past 100K.
    const flat = at(haiku, 10_000, 80_000) + at(haiku, 20_000, 100_000) + at(haiku, 0, 100_000);
    expect(r.repriced["claude-haiku-5-5"]?.["claude-haiku-5-5"]).toBeCloseTo(sub, 12);
    expect(r.repriced["claude-haiku-5-5"]?.["claude-opus-5-5"]).toBeCloseTo(flat, 12);
    expect(Object.keys(r.repriced).sort()).toEqual(["claude-haiku-5-5", "claude-opus-5-5"]);
  });

  test("Claude's calls by effort level, the advisor's left out; sessions with the advisor", async () => {
    const db = openDb(":memory:");
    db.query("INSERT INTO agent_places (id, cwd, branch) VALUES (1, '/r/x', '')").run();
    const insert = db.query(
      `INSERT INTO agent_usage (harness, id, session_id, place_id, agent, skill, model, at,
         input, cache_read, cache_write, cache_write_1h, output, role, effort)
       VALUES (?, ?, ?, 1, ?, '', 'claude-opus-5-5', ?, 10, 0, 0, 0, 0, ?, ?)`,
    );
    insert.run("claude", "m1", "s-1", "", T, "call", "high");
    insert.run("claude", "m2", "s-1", "Explore", T, "call", "high");
    insert.run("claude", "m3", "s-2", "", T, "call", "medium");
    insert.run("claude", "m4", "s-1", "", T, "advisor", "");
    insert.run("claude", "m5", "s-3", "", T, "call", "");
    insert.run("codex", "m6", "s-4", "", T, "call", "");
    const r = await usageReport(db, config, { from: "2026-10-05", to: "2026-10-05" });
    expect(r.byEffort.map((l) => [l.key, l.calls]).sort()).toEqual([
      ["", 1],
      ["high", 2],
      ["medium", 1],
    ]);
    expect([r.advisorSessions, r.claudeSessions]).toEqual([1, 3]);
  });

  test("a session filed under an objective counts there; its terminal's later choice files only later sessions", async () => {
    const config = ConfigSchema.parse({
      jira: { site: "https://x.atlassian.net", project: "ABC" },
    });
    const db = openDb(":memory:");
    // The folder names ABC-9: without a filed objective, that is where the work would go.
    db.query(
      "INSERT INTO agent_places (id, cwd, branch) VALUES (1, '/r/abc-9', 'feature/ABC-9')",
    ).run();
    const insert = db.query(
      `INSERT INTO agent_usage (harness, id, session_id, place_id, agent, skill, model, at,
         input, cache_read, cache_write, cache_write_1h, output, role)
       VALUES ('claude', ?, ?, 1, '', '', 'claude-opus-5-5', '2026-10-05T10:00:00.000Z', 10, 0, 0, 0, 10, 'call')`,
    );
    for (const n of [1, 2, 3]) insert.run(`m${n}`, `s-${n}`);
    const objectives = new ObjectiveStore(db);
    const goal = objectives.createGoal("Refactor the host");
    const t = { id: "t", harness: "claude", ticket: null } as TerminalInfo;
    objectives.choose(t, { objective: goal.id as number });
    objectives.freeze(t, "s-1");
    objectives.choose(t, { ticket: "ABC-2" });
    objectives.freeze(t, "s-2");

    const r = await usageReport(
      db,
      config,
      { from: "2026-10-05", to: "2026-10-05" },
      objectives.sessions(),
    );
    expect(Object.fromEntries(r.byTicket.map((l) => [l.key, l.calls]))).toEqual({
      [`goal:${goal.id}`]: 1,
      "ABC-2": 1,
      "ABC-9": 1,
    });
    expect(r.goals).toEqual({ [`goal:${goal.id}`]: "Refactor the host" });
    expect(r.tickets[`goal:${goal.id}`]?.sessionCount).toBe(1);
    expect(r.bySession.find((s) => s.sessionId === "s-1")?.ticket).toBe(`goal:${goal.id}`);
  });

  test("adds up a date range by ticket, env, model, skill and session, and lists unpriced models", async () => {
    const db = openDb(":memory:");
    const home = mkdtempSync(join(tmpdir(), "aos-usage-"));
    try {
      const dir = join(home, ".claude", "projects", "-w");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "s-1.jsonl"),
        [
          assistant({ attributionSkill: "flow" }),
          assistant({ cwd: "/r/app", gitBranch: "main" }, { id: "msg_2", model: "gpt-x" }),
          assistant({ timestamp: "2026-09-01T10:00:00.000Z" }, { id: "msg_old" }),
          "",
        ].join("\n"),
      );
      db.query(
        "INSERT INTO terminal_sessions (id, harness, location, cwd, state, started_at, session_id, name) VALUES ('t', 'claude', 'app', '/w', 'running', ?, 's-1', 'mi terminal')",
      ).run(T);
      const ingest = new UsageIngest({ db, home, grokUsage: null });
      await ingest.run();
      const r = await usageReport(db, config, { from: "2026-10-01", to: "2026-10-05" });
      // 2 + 1000 + 100 + 200 + 40 tokens at the 5.5 price.
      const cost = (2 * 5 + 1000 * 0.5 + 100 * 6.25 + 200 * 6.25 + 40 * 25) / 1e6;
      expect(r.total.calls).toBe(2);
      expect(r.total.cost).toBeCloseTo(cost, 12);
      expect(r.total.unpricedTokens).toBe(1342);
      expect(r.byTicket.map((l) => [l.key, l.calls])).toEqual([
        ["ABC-1033", 1],
        ["", 1],
      ]);
      expect(r.byLocation.map((l) => l.key)).toEqual(["abc-1033", "app"]);
      expect(r.bySkill.map((l) => l.key)).toEqual(["flow"]);
      expect(r.unpriced).toEqual(["gpt-x"]);
      expect(r.bySession).toHaveLength(1);
      expect(r.bySession[0]).toMatchObject({
        terminal: "mi terminal",
        models: ["claude-opus-5-5", "gpt-x"],
      });

      const deps = { config, db, objectives: new ObjectiveStore(db) } as Services;
      const bad = await usageRoutes(deps, ingest).request("/?from=2026-10-05&to=2026-10-01");
      expect(bad.status).toBe(400);
      const ok = await usageRoutes(deps, ingest).request("/?from=2026-09-01&to=2026-09-01");
      const body = (await ok.json()) as { total: { calls: number }; ingest: { files: number } };
      expect(body.total.calls).toBe(1);
      expect(body.ingest.files).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("report over days, tickets and weeks", () => {
  const config = ConfigSchema.parse({
    jira: { site: "https://x.atlassian.net", project: "ABC" },
    pricing: { "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } },
  });
  let tz: string | undefined;
  beforeEach(() => {
    // bun test runs in UTC without setting TZ: restoring `undefined` would write the string
    // "undefined", which Bun reads as the system zone, while formatters made earlier stay UTC.
    tz = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    process.env.TZ = "Europe/Madrid";
  });
  afterEach(() => {
    process.env.TZ = tz;
  });

  type Call = { at: string; branch?: string; session?: string; model?: string; skill?: string };
  const seed = (calls: Call[]) => {
    const db = openDb(":memory:");
    calls.forEach((c, i) => {
      const branch = c.branch ?? "";
      db.query("INSERT OR IGNORE INTO agent_places (cwd, branch) VALUES ('/r/x', ?)").run(branch);
      const place = db
        .query<{ id: number }, [string]>("SELECT id FROM agent_places WHERE branch = ?")
        .get(branch)?.id;
      db.query(
        `INSERT INTO agent_usage (harness, id, session_id, place_id, agent, skill, model, at,
           input, cache_read, cache_write, cache_write_1h, output)
         VALUES ('claude', ?, ?, ?, '', ?, ?, ?, 10, 1000, 100, 0, 50)`,
      ).run(
        `m${i}`,
        c.session ?? "s-1",
        place ?? 0,
        c.skill ?? "",
        c.model ?? "claude-opus-5-5",
        c.at,
      );
    });
    return db;
  };
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const tokens = (l: { tokens: Record<string, number> }) => sum(Object.values(l.tokens));

  test("each local day gets its calls, across the change of hour, and the days add up to the total", async () => {
    const db = seed([
      // 00:30 on the 25th in Madrid (summer time), though still the 24th in UTC.
      { at: "2026-10-24T22:30:00.000Z", branch: "ABC-1" },
      // 23:30 on the 25th, after the clocks went back an hour.
      { at: "2026-10-25T22:30:00.000Z", branch: "ABC-1" },
      { at: "2026-10-26T00:30:00.000Z" },
    ]);
    const r = await usageReport(db, config, { from: "2026-10-24", to: "2026-10-26" });
    expect(r.days).toEqual(["2026-10-24", "2026-10-25", "2026-10-26"]);
    expect(r.tickets["*"]?.daily.tokens).toEqual([0, 2320, 1160]);
    expect(r.tickets["ABC-1"]?.daily.tokens).toEqual([0, 2320, 0]);
    expect(r.tickets[""]?.daily.tokens).toEqual([0, 0, 1160]);
    for (const key of ["*", "ABC-1", ""]) {
      const line = key === "*" ? r.total : r.byTicket.find((l) => l.key === key);
      if (!line) throw new Error(key);
      expect(sum(r.tickets[key]?.daily.tokens ?? [])).toBe(tokens(line));
      expect(sum(r.tickets[key]?.daily.cost ?? [])).toBeCloseTo(line.cost ?? 0, 12);
    }
    // Cache reads at 0.2 instead of 4 per million.
    expect(r.total.saved).toBeCloseTo((3 * 1000 * (4 - 0.2)) / 1e6, 12);
  });

  test("with no start the range is the whole history, with nothing before it to compare", async () => {
    const db = seed([
      { at: "2026-09-02T10:00:00.000Z" },
      { at: "2026-10-05T10:00:00.000Z", branch: "ABC-2" },
    ]);
    const all = await usageReport(db, config, { to: "2026-10-05" });
    expect(all.from).toBe("2026-09-02");
    expect(all.firstDay).toBe("2026-09-02");
    expect(all.days).toHaveLength(34);
    expect(all.previous).toBeNull();
    expect(all.total.calls).toBe(2);
    const week = await usageReport(db, config, { from: "2026-09-29", to: "2026-10-05" });
    expect(week.previous).toMatchObject({ from: "2026-09-22", to: "2026-09-28" });
    expect(week.previous?.total.calls).toBe(0);
    const month = await usageReport(db, config, { from: "2026-10-01", to: "2026-10-31" });
    expect(month.previous).toMatchObject({ from: "2026-08-31", to: "2026-09-30" });
    expect(month.previous?.byTicket.map((l) => [l.key, l.calls])).toEqual([["", 1]]);
  });

  test("the report lets the server answer other requests between its queries", async () => {
    // Bun serves on one thread, terminal WebSockets included: a report read in one go held
    // them all for ~100 ms each minute while Consumo was open.
    const db = seed([{ at: "2026-10-05T10:00:00.000Z" }]);
    const order: string[] = [];
    const report = Promise.resolve(usageReport(db, config, { to: "2026-10-05" })).then(() =>
      order.push("report"),
    );
    setImmediate(() => order.push("other request"));
    await report;
    expect(order).toEqual(["other request", "report"]);
  });

  test("a ticket keeps every session of its own, past the report's top 100", async () => {
    const calls: Call[] = Array.from({ length: 103 }, (_, i) => ({
      at: `2026-10-05T10:${String(i % 60).padStart(2, "0")}:00.000Z`,
      session: `big-${i}`,
      model: "gpt-x",
    }));
    calls.push(
      { at: "2026-10-05T08:00:00.000Z", branch: "ABC-3", session: "small", skill: "flow" },
      { at: "2026-10-05T09:00:00.000Z", branch: "ABC-3", session: "small" },
    );
    const r = await usageReport(seed(calls), config, { from: "2026-10-05", to: "2026-10-05" });
    expect(r.bySession).toHaveLength(100);
    expect(r.tickets["*"]?.sessionCount).toBe(104);
    expect(r.tickets["*"]?.sessions).toHaveLength(20);
    const t = r.tickets["ABC-3"];
    expect(t?.sessionCount).toBe(1);
    expect(t?.sessions.map((s) => s.sessionId)).toEqual(["small"]);
    expect(t?.activeHours).toBe(1);
    expect(t?.skills.map((l) => [l.key, l.calls])).toEqual([["flow", 1]]);
    expect(t?.models.map((l) => l.key)).toEqual(["claude-opus-5-5"]);
    expect(t?.harnesses.map((l) => l.key)).toEqual(["claude"]);
  });
});

describe("activity", () => {
  const NOW = Date.parse("2026-10-06T10:00:00.000Z");
  const call = (
    db: ReturnType<typeof openDb>,
    id: string,
    harness: string,
    session: string,
    at: string,
  ) =>
    db
      .query(
        `INSERT INTO agent_usage (harness, id, session_id, place_id, agent, skill, model, at,
           input, cache_read, cache_write, cache_write_1h, output)
         VALUES (?, ?, ?, 1, '', '', 'm', ?, 1, 1, 1, 0, 1)`,
      )
      .run(harness, id, session, at);

  test("calls of the last two hours in five-minute bars, by app terminal or by harness and session", () => {
    const db = openDb(":memory:");
    db.query("INSERT INTO agent_places (id, cwd, branch) VALUES (1, '/w', '')").run();
    db.query(
      "INSERT INTO terminal_sessions (id, harness, location, cwd, state, started_at, session_id) VALUES ('t-1', 'claude', 'app', '/w', 'running', ?, 's-1'), ('t-2', 'claude', 'app', '/w', 'running', ?, 's-quiet'), ('t-3', 'claude', 'app', '/w', 'exited', ?, 's-gone')",
    ).run(T, T, T);
    call(db, "a", "claude", "s-1", "2026-10-06T09:59:59.000Z");
    call(db, "b", "claude", "s-1", "2026-10-06T09:56:00.000Z");
    call(db, "c", "claude", "s-1", "2026-10-06T08:00:00.000Z");
    // Grok writes its offset as +00:00.
    call(db, "d", "grok", "g-1", "2026-10-06T09:01:00.5+00:00");
    // Before the window.
    call(db, "e", "codex", "x-1", "2026-10-06T07:59:59.000Z");
    const a = activityOf(db, NOW);
    expect(a.slotMs).toBe(SLOT_MS);
    expect(Object.keys(a.calls).sort()).toEqual(["grok:g-1", "t-1", "t-2"]);
    expect(a.calls["t-1"]).toHaveLength(SLOTS);
    expect(a.calls["t-1"]?.[0]).toBe(1);
    expect(a.calls["t-1"]?.[SLOTS - 1]).toBe(2);
    expect(a.calls["grok:g-1"]?.[12]).toBe(1);
    // A running terminal with no call is quiet, not unknown; an ended one is left out.
    expect(a.calls["t-2"]?.every((n) => n === 0)).toBe(true);
  });

  test("the route reads the transcripts again when the last read is older than half a minute", async () => {
    const db = openDb(":memory:");
    const home = mkdtempSync(join(tmpdir(), "aos-usage-"));
    try {
      const ingest = new UsageIngest({ db, home, grokUsage: null });
      const app = usageRoutes(
        { config: ConfigSchema.parse({}), db, objectives: new ObjectiveStore(db) } as Services,
        ingest,
      );
      const res = await app.request("/activity");
      expect(res.status).toBe(200);
      const first = ingest.last?.startedAt;
      expect(first).toBeDefined();
      await app.request("/activity");
      expect(ingest.last?.startedAt).toBe(first);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Jira briefs", () => {
  const brief = { title: "Retry the webhook", status: { name: "Hecho", category: "done" } };

  test("an unknown key is null and kept; a failure is thrown and never kept", async () => {
    let t = 0;
    const asked: string[] = [];
    let down = false;
    const load = briefLoader(
      async (key) => {
        asked.push(key);
        if (down) throw new ProviderError("jira", 503, "down");
        if (key === "ABC-404") throw new ProviderError("jira", 404, "gone");
        return brief;
      },
      () => t,
    );
    expect(await load(["ABC-1", "ABC-404", "ABC-1"])).toEqual({ "ABC-1": brief, "ABC-404": null });
    expect(await load(["ABC-1", "ABC-404"])).toEqual({ "ABC-1": brief, "ABC-404": null });
    expect(asked).toEqual(["ABC-1", "ABC-404"]);
    down = true;
    t = BRIEF_TTL_MS;
    await expect(load(["ABC-1"])).rejects.toThrow("down");
    down = false;
    expect(await load(["ABC-1"])).toEqual({ "ABC-1": brief });
    expect(asked).toEqual(["ABC-1", "ABC-404", "ABC-1", "ABC-1"]);
  });

  test("the route checks the keys and answers disabled with no Jira", async () => {
    const db = openDb(":memory:");
    const ingest = new UsageIngest({ db, home: "/nonexistent", grokUsage: null });
    const get = async () => brief;
    const jira = ConfigSchema.parse({ jira: { site: "https://x.atlassian.net", project: "ABC" } });
    const app = usageRoutes(
      { config: jira, db, objectives: new ObjectiveStore(db) } as Services,
      ingest,
      get,
    );
    expect((await app.request("/jira?keys=abc-1")).status).toBe(400);
    expect(await (await app.request("/jira?keys=ABC-1,ABC-2")).json()).toEqual({
      briefs: { "ABC-1": brief, "ABC-2": brief },
    });
    const none = usageRoutes(
      { config: ConfigSchema.parse({}), db, objectives: new ObjectiveStore(db) } as Services,
      ingest,
      get,
    );
    expect(await (await none.request("/jira?keys=ABC-1")).json()).toEqual({ disabled: true });
    const all = await usageRoutes(
      { config: jira, db, objectives: new ObjectiveStore(db) } as Services,
      ingest,
      get,
    ).request("/?to=2026-10-05");
    expect(all.status).toBe(200);
  });
});
