import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_PASTE_IMAGE_BYTES } from "../../../shared/terminals.ts";
import { IDLE_TIMEOUT_S } from "../../deadline.ts";
import { run } from "../../run.ts";
import { MacError, type MacRunner, runHelper } from "../mac/run.ts";
import { ImageError } from "./store.ts";

// "Capturar" in the image history. macOS: the system's own selection (`screencapture -i`: drag
// a zone, Space for a window, Esc to cancel), run by AgenticCapture.app, the bundle macOS
// grants Screen Recording to (scripts/mac/AgenticCapture.swift); run from the server's own
// process tree it answers to Terminal and is denied. The image goes to the user's temp folder,
// never data/: the repo may sit under Desktop, which macOS guards per app. Windows: the
// Snipping Tool overlay, which leaves the cut on the clipboard; the user pastes it with Ctrl+V.

export type CaptureRun = (
  argv: string[],
  timeoutMs: number,
) => Promise<{ code: number | null; stderr: string }>;

export type Captured =
  | { kind: "image"; bytes: Uint8Array }
  | { kind: "cancelled" }
  | { kind: "clipboard" };

// The user may take their time choosing; the answer still comes before the server drops an
// idle request. The helper closes the selection 5 s before this.
export const CAPTURE_TIMEOUT_MS = (IDLE_TIMEOUT_S - 20) * 1000;

export const runCapture = runHelper("AgenticCapture");

const bunRun: CaptureRun = (argv, timeoutMs) => run(argv, { timeoutMs });

export async function capture({
  platform = process.platform,
  run = bunRun,
  helper = runCapture,
  dir = tmpdir(),
}: {
  platform?: NodeJS.Platform;
  run?: CaptureRun;
  helper?: MacRunner;
  dir?: string;
} = {}): Promise<Captured> {
  if (platform === "win32") {
    // explorer exits 1 even when it opened the URI, so its code says nothing.
    await run(["explorer.exe", "ms-screenclip:"], 10_000);
    return { kind: "clipboard" };
  }
  if (platform !== "darwin")
    throw new ImageError("capture is not available on this system", "capture_unavailable");
  const path = join(dir, `aos-capture-${randomUUID()}.png`);
  try {
    await helper(["capture", path, String(MAX_PASTE_IMAGE_BYTES)], CAPTURE_TIMEOUT_MS);
    const file = Bun.file(path);
    if (!(await file.exists()))
      throw new ImageError("AgenticCapture wrote no image", "capture_failed");
    return { kind: "image", bytes: await file.bytes() };
  } catch (err) {
    if (!(err instanceof MacError)) throw err;
    // Esc, or the time running out, is no capture.
    if (err.code === "cancelled" || err.code === "timeout") return { kind: "cancelled" };
    if (err.code === "denied")
      throw new ImageError("Screen Recording is not granted to AgenticCapture", "capture_denied");
    if (err.code === "not_installed") throw new ImageError(err.message, "capture_unavailable");
    throw new ImageError(`AgenticCapture: ${err.message}`, "capture_failed");
  } finally {
    await rm(path, { force: true });
  }
}
