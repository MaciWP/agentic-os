import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_PASTE_IMAGE_BYTES } from "../../../shared/terminals.ts";
import { helperApp } from "../mac/run.ts";
import { CaptureHotkey, HOTKEY_RETRIES, type HotkeySpawn } from "./hotkey.ts";

// `open -W` as the helper leaves it: running until the test ends it with a code.
function launcher() {
  const launches: { argv: string[]; end: (code: number | null) => void }[] = [];
  const spawn: HotkeySpawn = (argv) => {
    let end = (_: number | null) => {};
    const exited = new Promise<number | null>((resolve) => {
      end = resolve;
    });
    launches.push({ argv, end });
    return { exited };
  };
  return { launches, spawn };
}

// Waits for what a step needs, not for a time: a loaded machine can take longer than any
// fixed pause, and a fixed pause made this file fail now and then.
async function until(done: () => boolean, ms = 2_000) {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error("the condition was not met in time");
    await Bun.sleep(1);
  }
}
// For "nothing more happens": long enough for a retry (1 ms here) to have started.
const quiet = () => Bun.sleep(20);

describe("CaptureHotkey", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-hotkey-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  let n = 0;
  const make = (extra: Partial<ConstructorParameters<typeof CaptureHotkey>[0]> = {}) => {
    const { launches, spawn } = launcher();
    const stopped: number[] = [];
    const hotkey = new CaptureHotkey({
      port: 4317,
      dir: join(root, `captures-${n++}`),
      spawn,
      stop: async (pid) => {
        stopped.push(pid);
      },
      pid: 4242,
      retryMs: 1,
      ...extra,
    });
    return { hotkey, launches, stopped };
  };

  test("starts the helper through Launch Services, into a private folder of its own", async () => {
    const { hotkey, launches } = make();
    expect(hotkey.state()).toEqual({ state: "off", detail: null });
    hotkey.start();
    hotkey.start();
    await until(() => launches.length > 0);
    await quiet();
    expect(launches).toHaveLength(1);
    expect(launches[0]?.argv).toEqual([
      "open",
      "-n",
      "-g",
      "-W",
      "-a",
      helperApp("AgenticCapture"),
      "--args",
      "hotkey",
      "4242",
      "http://127.0.0.1:4317",
      hotkey.dir,
      String(MAX_PASTE_IMAGE_BYTES),
    ]);
    expect(statSync(hotkey.dir).mode & 0o777).toBe(0o700);
    expect(hotkey.state().state).toBe("starting");
    expect(hotkey.report({ state: "ready", pid: 77 })).toBe(true);
    expect(hotkey.state()).toEqual({ state: "ready", detail: null });
    hotkey.stop();
  });

  test("takes the word of the helper it started only", async () => {
    const { hotkey, launches } = make();
    expect(hotkey.report({ state: "ready", pid: 77 })).toBe(false);
    hotkey.start();
    await until(() => launches.length === 1);
    expect(hotkey.report({ state: "ready", pid: 77 })).toBe(true);
    expect(hotkey.report({ state: "failed", pid: 78 })).toBe(false);
    expect(hotkey.state().state).toBe("ready");
    hotkey.stop();
    expect(hotkey.report({ state: "ready", pid: 77 })).toBe(false);
    expect(hotkey.state().state).toBe("off");
  });

  test("a kept shot ends the capture; stopping ends the helper it reported", async () => {
    const { hotkey, launches, stopped } = make();
    hotkey.start();
    await until(() => launches.length === 1);
    hotkey.report({ state: "capturing", pid: 77 });
    hotkey.settled();
    expect(hotkey.state().state).toBe("ready");
    hotkey.stop();
    expect(stopped).toEqual([77]);
    // The stopped `open` ending is not a failure, and nothing starts again.
    launches[0]?.end(0);
    await quiet();
    expect(hotkey.state().state).toBe("off");
    expect(launches).toHaveLength(1);
  });

  test("a missing app is said, and not tried again", async () => {
    const { hotkey, launches } = make();
    hotkey.start();
    await until(() => launches.length === 1);
    launches[0]?.end(1);
    await until(() => hotkey.state().state === "not_installed");
    await quiet();
    expect(hotkey.state().detail).toContain("bun run mac:build AgenticCapture");
    expect(launches).toHaveLength(1);
  });

  test("a helper that ends on its own is started again a few times, then left failed", async () => {
    const { hotkey, launches } = make();
    hotkey.start();
    for (let i = 0; i <= HOTKEY_RETRIES; i++) {
      await until(() => launches.length === i + 1);
      launches.at(-1)?.end(0);
    }
    await until(() => hotkey.state().state === "failed");
    await quiet();
    expect(launches).toHaveLength(HOTKEY_RETRIES + 1);
    expect(hotkey.state()).toEqual({ state: "failed", detail: "the helper ended" });
  });

  test("keys the system refused are tried once more, then stay taken", async () => {
    const { hotkey, launches } = make();
    hotkey.start();
    for (let i = 0; i < 2; i++) {
      await until(() => launches.length === i + 1);
      hotkey.report({ state: "taken", pid: 70 + i, detail: "RegisterEventHotKey -9878" });
      launches.at(-1)?.end(0);
    }
    await quiet();
    expect(launches).toHaveLength(2);
    expect(hotkey.state()).toEqual({ state: "taken", detail: "RegisterEventHotKey -9878" });
  });

  test("a link in place of its folder is refused before anything starts", async () => {
    const dir = join(root, "linked");
    symlinkSync(root, dir);
    const { hotkey, launches } = make({ dir });
    hotkey.start();
    await until(() => hotkey.state().state === "failed");
    expect(launches).toHaveLength(0);
    expect(hotkey.state().state).toBe("failed");
    expect(hotkey.state().detail).toContain("not a folder of this user");
    hotkey.stop();
  });

  test("a grant starts a new helper; a refusal opens System Settings instead", async () => {
    const asked: string[][] = [];
    let granted = false;
    let settings = 0;
    const { hotkey, launches, stopped } = make({
      helper: async (args) => {
        asked.push(args);
        return { granted };
      },
      openSettings: async () => {
        settings++;
      },
    });
    hotkey.start();
    await until(() => launches.length === 1);
    hotkey.report({ state: "denied", pid: 77 });
    expect(await hotkey.grant()).toEqual({ granted: false });
    expect([settings, launches.length, stopped]).toEqual([1, 1, []]);
    granted = true;
    const grant = hotkey.grant();
    await until(() => stopped.length === 1);
    launches[0]?.end(0);
    expect(await grant).toEqual({ granted: true });
    await until(() => launches.length === 2);
    expect(asked).toEqual([["grant"], ["grant"]]);
    expect([settings, launches.length, stopped]).toEqual([1, 2, [77]]);
    expect(hotkey.state().state).toBe("starting");
    hotkey.stop();
  });
});
