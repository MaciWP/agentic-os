import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_PASTE_IMAGE_BYTES } from "../../../shared/terminals.ts";
import { MacError, type MacReason, type MacRunner } from "../mac/run.ts";
import { CAPTURE_TIMEOUT_MS, type CaptureRun, capture } from "./capture.ts";
import { ImageError } from "./store.ts";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

describe("capture", () => {
  const dir = mkdtempSync(join(tmpdir(), "aos-capture-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // AgenticCapture as the user leaves it: a selection written to the path, or a reason.
  const agentic = (outcome: { write?: Buffer; reason?: MacReason }, seen: string[][] = []) =>
    (async (args, timeoutMs) => {
      seen.push([...args, String(timeoutMs)]);
      if (outcome.write) writeFileSync(args[1] ?? "", outcome.write);
      if (outcome.reason) throw new MacError(outcome.reason, "said by the helper");
      return { captured: true };
    }) satisfies MacRunner;
  const mac = (helper: MacRunner) => capture({ platform: "darwin", dir, helper });

  test("macOS: the selection's bytes, from a temporary file that is then removed", async () => {
    const seen: string[][] = [];
    expect(await mac(agentic({ write: png }, seen))).toEqual({
      kind: "image",
      bytes: new Uint8Array(png),
    });
    const [args] = seen;
    expect(args?.[0]).toBe("capture");
    expect(args?.[1]).toMatch(new RegExp(`^${dir}/aos-capture-[0-9a-f-]{36}\\.png$`));
    expect(args?.[2]).toBe(String(MAX_PASTE_IMAGE_BYTES));
    expect(args?.[3]).toBe(String(CAPTURE_TIMEOUT_MS));
    expect(readdirSync(dir)).toEqual([]);
  });

  test("macOS: Esc or the time running out is a cancel", async () => {
    for (const reason of ["cancelled", "timeout"] as const)
      expect(await mac(agentic({ reason }))).toEqual({ kind: "cancelled" });
  });

  test("macOS: each refusal is its own error, with nothing left behind", async () => {
    const code = (outcome: { write?: Buffer; reason?: MacReason }) =>
      mac(agentic(outcome)).then(
        () => null,
        (e: ImageError) => [e.constructor, e.code],
      );
    expect(await code({ reason: "denied" })).toEqual([ImageError, "capture_denied"]);
    expect(await code({ reason: "not_installed" })).toEqual([ImageError, "capture_unavailable"]);
    expect(await code({ reason: "not_inherited" })).toEqual([ImageError, "capture_failed"]);
    expect(await code({ write: png, reason: "failed" })).toEqual([ImageError, "capture_failed"]);
    // Said it captured, wrote nothing.
    expect(await code({})).toEqual([ImageError, "capture_failed"]);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("Windows opens the Snipping Tool overlay; the cut arrives by the clipboard", async () => {
    const seen: string[][] = [];
    const run: CaptureRun = async (argv) => {
      seen.push(argv);
      return { code: 1, stderr: "" };
    };
    expect(await capture({ platform: "win32", dir, run })).toEqual({ kind: "clipboard" });
    expect(seen[0]?.slice(0, 2)).toEqual(["explorer.exe", "ms-screenclip:"]);
  });

  test("other systems have no capture", async () => {
    await expect(capture({ platform: "linux", dir })).rejects.toThrow(ImageError);
  });
});
