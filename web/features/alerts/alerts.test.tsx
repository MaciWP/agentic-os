import { afterEach, describe, expect, test } from "bun:test";
import { shouldPlay } from "../../chime.ts";
import { isNextKey } from "../../keys.ts";
import type { JobSummary } from "../projects/env-jobs.ts";
import { waitCount } from "../terminals/panel.tsx";
import { terminal } from "../terminals/test-fixtures.ts";
import {
  alerts,
  dismiss,
  dismissTerminals,
  jobAlert,
  newlyFinished,
  raise,
  restore,
  terminalAlert,
} from "./alerts.ts";
import { faviconSvg } from "./favicon.ts";
import { pending, queueOf, tuneFor, tuneOf } from "./signals.tsx";

const job = (over: Partial<JobSummary>): JobSummary => ({
  id: "j1",
  action: "start",
  env: "abc-732",
  state: "running",
  error: null,
  startedAt: "2026-10-07T09:00:00Z",
  endedAt: null,
  ...over,
});
const needsYou = { sessionId: "s", state: "needs_you" as const };

describe("alert texts", () => {
  test("an agent that asks, one that finished its turn, and a terminal that ended", () => {
    const permission = terminalAlert(
      terminal({ id: "a", agent: { ...needsYou, asks: "permission" } }),
    );
    expect(permission).toMatchObject({ kind: "asks", detail: "pide permiso para seguir" });
    const asks = terminalAlert(terminal({ id: "a", agent: { ...needsYou, asks: "question" } }));
    expect(asks).toMatchObject({
      key: "terminal:a",
      kind: "asks",
      tone: "warn",
      title: "Claude · work/repo",
      detail: "te pregunta algo",
      tile: "a",
      terminal: "a",
    });
    expect(terminalAlert(terminal({ agent: needsYou }))).toMatchObject({
      kind: "turn",
      detail: "ha terminado su turno",
    });
    const shell = { harness: "shell" as const, name: "api" };
    expect(terminalAlert(terminal({ ...shell, state: "exited", exitCode: 0 }))).toMatchObject({
      kind: "ended",
      tone: "warn",
      title: "api · work/repo",
      detail: "ha terminado",
    });
    expect(terminalAlert(terminal({ ...shell, state: "exited", exitCode: 2 }))).toMatchObject({
      tone: "bad",
      detail: "ha terminado con código 2",
    });
    expect(terminalAlert(terminal({ ...shell, state: "lost" }))).toMatchObject({
      tone: "bad",
      detail: "se ha perdido",
    });
    expect(terminalAlert(terminal({ ...shell, state: "failed", error: "no zsh" }))).toMatchObject({
      tone: "bad",
      detail: "ha fallado: no zsh",
    });
  });

  test("an env command says what it did, and why it failed", () => {
    expect(jobAlert(job({ state: "ok" }))).toMatchObject({
      key: "job:j1",
      kind: "job_ok",
      tone: "ok",
      title: "Arrancar abc-732",
      detail: "listo",
      tile: "job:abc-732",
    });
    expect(jobAlert(job({ state: "failed", error: "port 8000 in use" }))).toMatchObject({
      kind: "job_failed",
      tone: "bad",
      detail: "ha fallado: port 8000 in use",
    });
    expect(jobAlert(job({ action: "doctor", env: null, state: "ok" }))).toMatchObject({
      title: "Diagnóstico",
      tile: null,
    });
  });

  test("a job counts when it finishes; the first read, or one already finished, does not", () => {
    const now = [job({ id: "a", state: "ok" }), job({ id: "b", state: "running" })];
    expect(newlyFinished(null, now)).toEqual([]);
    const before = new Map([
      ["a", "running" as const],
      ["b", "running" as const],
    ]);
    expect(newlyFinished(before, now).map((j) => j.id)).toEqual(["a"]);
    expect(newlyFinished(new Map([["a", "ok" as const]]), now)).toEqual([]);
    // Started and ended between two reads.
    expect(newlyFinished(new Map(), [job({ id: "c", state: "failed" })]).map((j) => j.id)).toEqual([
      "c",
    ]);
  });
});

describe("alert store", () => {
  afterEach(() => {
    for (const a of alerts.get()) dismiss(a.key);
  });

  test("newest first; a newer alert of the same terminal replaces it; looking at it drops it", () => {
    let calls = 0;
    const stop = alerts.subscribe(() => calls++);
    const turn = terminalAlert(terminal({ id: "a", agent: needsYou }));
    const failed = jobAlert(job({ state: "failed" }));
    raise([turn]);
    raise([failed]);
    raise([]);
    expect(alerts.get().map((a) => a.key)).toEqual(["job:j1", "terminal:a"]);
    const asks = terminalAlert(terminal({ id: "a", agent: { ...needsYou, asks: "question" } }));
    raise([asks]);
    expect(alerts.get()).toEqual([asks, failed]);
    dismissTerminals((id) => id !== "a");
    expect(alerts.get()).toEqual([failed]);
    dismiss("job:j1");
    dismiss("job:j1");
    expect(alerts.get()).toEqual([]);
    // Every change told the listeners once; an empty raise and a second dismiss did not.
    expect(calls).toBe(5);
    stop();
  });
  test("an alert brought back after a reload shows but stays quiet; a newer one sounds", () => {
    const turn = terminalAlert(terminal({ id: "a", agent: needsYou }));
    restore([turn]);
    expect(alerts.get()).toEqual([{ ...turn, quiet: true }]);
    const asks = terminalAlert(terminal({ id: "a", agent: { ...needsYou, asks: "question" } }));
    raise([asks]);
    expect(alerts.get()).toEqual([asks]);
    expect(asks.quiet).toBeUndefined();
  });
});

describe("signals", () => {
  const turn = terminalAlert(terminal({ id: "a", agent: needsYou }));
  const asks = terminalAlert(terminal({ id: "b", agent: { ...needsYou, asks: "question" } }));
  const ended = terminalAlert(terminal({ id: "c", state: "exited", exitCode: 0 }));
  const broke = terminalAlert(terminal({ id: "d", state: "exited", exitCode: 2 }));
  const fail = jobAlert(job({ state: "failed", error: "boom" }));
  const ok = jobAlert(job({ id: "j2", state: "ok" }));

  test("each kind has its tune: asking, failing, done with a turn or an exit, a job done", () => {
    expect([asks, fail, broke, turn, ended, ok].map(tuneFor)).toEqual([
      "asks",
      "failed",
      "failed",
      "turn",
      "turn",
      "done",
    ]);
  });

  test("a burst sounds as its most pressing kind", () => {
    expect(tuneOf([ok, turn, fail, asks])).toBe("failed");
    expect(tuneOf([ok, turn, asks])).toBe("asks");
    expect(tuneOf([ok, turn])).toBe("turn");
    expect(tuneOf([ok])).toBe("done");
  });

  test("«Siguiente» goes by kind, then the one waiting longest; a finished job is not pending", () => {
    // The store keeps the newest first.
    const store = [ok, turn, asks, ended, fail];
    expect(queueOf(store).map((a) => a.key)).toEqual([
      fail.key,
      asks.key,
      ended.key,
      turn.key,
      ok.key,
    ]);
    expect(pending(store)).toBe(4);
  });

  test("within a burst only a more pressing tune sounds again", () => {
    const last = { at: 1000, tune: "turn" as const };
    expect(shouldPlay(2000, "turn", last)).toBe(false);
    expect(shouldPlay(2000, "done", last)).toBe(false);
    expect(shouldPlay(2000, "asks", last)).toBe(true);
    expect(shouldPlay(2000, "failed", last)).toBe(true);
    expect(shouldPlay(4000, "done", last)).toBe(true);
  });

  test("⌘⇧. on a Mac and Ctrl+Shift+. elsewhere, by the key's place", () => {
    const key = { code: "Period", shiftKey: true, altKey: false, metaKey: false, ctrlKey: false };
    expect(isNextKey({ ...key, metaKey: true }, true)).toBe(true);
    expect(isNextKey({ ...key, ctrlKey: true }, true)).toBe(false);
    expect(isNextKey({ ...key, ctrlKey: true }, false)).toBe(true);
    expect(isNextKey({ ...key, metaKey: true, shiftKey: false }, true)).toBe(false);
    expect(isNextKey({ ...key, metaKey: true, code: "Comma" }, true)).toBe(false);
  });

  test("a Mesa counts what waits by kind", () => {
    const list = [
      terminal({ id: "a", agent: needsYou }),
      terminal({ id: "b", agent: { ...needsYou, asks: "question" } }),
      terminal({ id: "c", state: "failed" }),
      terminal({ id: "e", agent: needsYou }),
    ];
    const count = waitCount(list, new Set(["a", "b", "c"]));
    expect(count).toEqual({ asks: 1, failed: 1, turn: 1 });
  });
});

test("the tab icon carries the count, capped at 9+", () => {
  expect(faviconSvg(0)).not.toContain("#f2a93b");
  expect(faviconSvg(2)).toContain("#f2a93b");
  expect(faviconSvg(2)).toContain(">2</text>");
  expect(faviconSvg(12)).toContain(">9+</text>");
});
