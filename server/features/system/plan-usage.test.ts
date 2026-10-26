import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexUsage, readPlanUsage } from "./plan-usage.ts";

describe("subscription usage", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "aos-plan-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("the statusline's cache gives the session and weekly percent, dated by the file", async () => {
    const file = join(dir, "usage.json");
    writeFileSync(
      file,
      JSON.stringify({
        sessionUsage: 8,
        sessionResetAt: "2026-10-06T17:30:00.311500+00:00",
        weeklyUsage: 29,
        weeklyResetAt: "2026-10-09T18:00:00.311525+00:00",
        weeklySonnetUsage: 0,
        extraUsageEnabled: false,
      }),
    );
    const at = new Date("2026-10-06T14:00:00Z");
    utimesSync(file, at, at);
    expect(await readPlanUsage([file])).toEqual({
      windows: [
        { minutes: 300, percent: 8, resetAt: "2026-10-06T17:30:00.311500+00:00" },
        { minutes: 10_080, percent: 29, resetAt: "2026-10-09T18:00:00.311525+00:00" },
      ],
      updatedAt: "2026-10-06T14:00:00.000Z",
    });
  });

  test("the file written last wins, and a missing one is skipped", async () => {
    const write = (name: string, sessionUsage: number, at: string) => {
      const file = join(dir, name);
      writeFileSync(file, JSON.stringify({ sessionUsage, weeklyUsage: 1 }));
      utimesSync(file, new Date(at), new Date(at));
      return file;
    };
    const hud = write("hud.json", 40, "2026-10-11T10:00:00Z");
    const old = write("old.json", 8, "2026-10-11T09:00:00Z");
    const missing = join(dir, "nope.json");
    const usage = await readPlanUsage([missing, old, hud]);
    expect(usage).toMatchObject({
      updatedAt: "2026-10-11T10:00:00.000Z",
      windows: [{ percent: 40 }, { percent: 1 }],
    });
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    expect(await readPlanUsage([missing, bad])).toEqual({ error: "bad_data" });
  });

  test("no file is no source, never zero percent", async () => {
    expect(await readPlanUsage([join(dir, "missing.json")])).toEqual({ error: "no_source" });
  });

  test("a file that is not the expected JSON is bad data", async () => {
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{not json");
    expect(await readPlanUsage([broken])).toEqual({ error: "bad_data" });
    const wrong = join(dir, "wrong.json");
    writeFileSync(wrong, JSON.stringify({ sessionUsage: "8" }));
    expect(await readPlanUsage([wrong])).toEqual({ error: "bad_data" });
    const empty = join(dir, "empty.json");
    writeFileSync(empty, JSON.stringify({ extraUsageEnabled: false }));
    expect(await readPlanUsage([empty])).toEqual({ error: "bad_data" });
  });
});

describe("Codex usage", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "aos-codex-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const limits = (percent: number, at: string, secondary: unknown = null) =>
    JSON.stringify({
      timestamp: at,
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          limit_id: "codex",
          primary: { used_percent: percent, window_minutes: 10080, resets_at: 1791803021 },
          secondary,
          plan_type: "prolite",
        },
      },
    });
  const rollout = (day: string, name: string, lines: string[], mtime: string) => {
    const dir = join(root, ...day.split("/"));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `rollout-${name}.jsonl`);
    writeFileSync(file, `${lines.join("\n")}\n`);
    utimesSync(file, new Date(mtime), new Date(mtime));
  };

  test("no sessions folder is no source", async () => {
    expect(await readCodexUsage(join(root, "missing"))).toEqual({ error: "no_source" });
  });

  test("the last reading of the rollout written last, even when it started days before", async () => {
    // Started on the 4th but written last: it holds the newest reading.
    rollout(
      "2026/10/04",
      "old-session",
      [
        limits(10, "2026-10-04T10:00:00.000Z"),
        '{"type":"event_msg","payload":{"type":"token_count","rate_limits":null}}',
        limits(13, "2026-10-06T15:31:00.628Z", {
          used_percent: 40,
          window_minutes: 300,
          resets_at: 1791300000,
        }),
        '{"type":"response_item","payload":{"type":"message"}}',
      ],
      "2026-10-06T15:31:00Z",
    );
    rollout(
      "2026/10/06",
      "new-session",
      [limits(99, "2026-10-06T09:00:00.000Z")],
      "2026-10-06T09:00:00Z",
    );
    expect(await readCodexUsage(root)).toEqual({
      windows: [
        { minutes: 300, percent: 40, resetAt: new Date(1791300000 * 1000).toISOString() },
        { minutes: 10_080, percent: 13, resetAt: new Date(1791803021 * 1000).toISOString() },
      ],
      updatedAt: "2026-10-06T15:31:00.628Z",
    });
  });

  test("a reading in another shape is bad data, never a guess", async () => {
    rollout(
      "2026/10/06",
      "changed-shape",
      [
        '{"timestamp":"2026-10-06T16:00:00.000Z","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":"13"}}}}',
      ],
      "2026-10-06T16:00:00Z",
    );
    expect(await readCodexUsage(root)).toEqual({ error: "bad_data" });
  });
});
