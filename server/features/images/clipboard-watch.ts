import { join } from "node:path";
import { z } from "zod";
import { MAX_PASTE_IMAGE_BYTES } from "../../../shared/terminals.ts";
import { errorMessage } from "../../error-message.ts";
import { log } from "../../log.ts";

// Off by default (images.watchClipboard): every image copied anywhere joins the history,
// without a paste. A long-lived script reads the clipboard: JXA on macOS, PowerShell on
// Windows. It prints one JSON line per image and ends when the server does.

export type WatchProcess = {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number | null>;
  kill(): void;
};
export type WatchSpawn = (argv: string[]) => WatchProcess;

export type WatchState = {
  state: "off" | "starting" | "watching" | "failed";
  detail: string | null;
};

const B64_MAX = Math.ceil(MAX_PASTE_IMAGE_BYTES / 3) * 4;
const Line = z.union([
  z.object({ ready: z.literal(true) }),
  z.object({ image: z.base64().max(B64_MAX) }),
  z.object({ tooLarge: z.number() }),
]);
// A failed start is retried this many times, this far apart, before it stays failed.
export const WATCH_RETRIES = 3;
export const WATCH_RETRY_MS = 10_000;
// A script that ran this long before ending was working: its end starts a fresh count.
export const WATCH_STABLE_MS = 60_000;

export function watchArgv(platform: NodeJS.Platform, pid: number): string[] | null {
  const script = (ext: string) => join(import.meta.dir, `clipboard-watch.${ext}`);
  if (platform === "darwin")
    return [
      "/usr/bin/osascript",
      "-l",
      "JavaScript",
      script("js"),
      String(pid),
      String(MAX_PASTE_IMAGE_BYTES),
    ];
  if (platform === "win32")
    return [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script("ps1"),
      "-ServerId",
      String(pid),
      "-Max",
      String(MAX_PASTE_IMAGE_BYTES),
    ];
  return null;
}

const bunSpawn: WatchSpawn = (argv) =>
  Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });

export class ClipboardWatch {
  private proc: WatchProcess | null = null;
  private status: WatchState = { state: "off", detail: null };
  private failures = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private readyAt: number | null = null;
  // One save at a time, so the same image copied twice is kept once.
  private saving = Promise.resolve();

  constructor(
    private readonly save: (bytes: Uint8Array) => Promise<unknown>,
    private readonly opts: {
      platform?: NodeJS.Platform;
      spawn?: WatchSpawn;
      pid?: number;
      retryMs?: number;
      stableMs?: number;
    } = {},
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.failures = 0;
    this.launch();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.proc?.kill();
    this.proc = null;
    this.status = { state: "off", detail: null };
  }

  state(): WatchState {
    return this.status;
  }

  // Resolves once the current script has ended and its output is handled; for tests.
  done: Promise<void> = Promise.resolve();

  private launch(): void {
    const argv = watchArgv(this.opts.platform ?? process.platform, this.opts.pid ?? process.pid);
    if (!argv) {
      this.status = { state: "failed", detail: "no clipboard watcher for this system" };
      return;
    }
    this.status = { state: "starting", detail: null };
    this.readyAt = null;
    let proc: WatchProcess;
    try {
      proc = (this.opts.spawn ?? bunSpawn)(argv);
    } catch (err) {
      this.ended(`could not start: ${errorMessage(err)}`);
      return;
    }
    this.proc = proc;
    this.done = Promise.all([this.read(proc), new Response(proc.stderr).text(), proc.exited])
      .then(([, stderr, code]) => {
        if (this.proc === proc) this.ended(`ended (${code}): ${stderr.trim() || "no message"}`);
      })
      .then(() => this.saving);
  }

  private async read(proc: WatchProcess): Promise<void> {
    const decoder = new TextDecoder();
    let rest = "";
    for await (const chunk of proc.stdout) {
      rest += decoder.decode(chunk, { stream: true });
      let newline = rest.indexOf("\n");
      while (newline !== -1) {
        this.handle(rest.slice(0, newline));
        rest = rest.slice(newline + 1);
        newline = rest.indexOf("\n");
      }
      // A line longer than any image is not the script talking.
      if (rest.length > B64_MAX + 64) {
        this.ended("printed an unreadable line");
        proc.kill();
        return;
      }
    }
  }

  private handle(text: string): void {
    if (!text.trim()) return;
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {}
    const line = Line.safeParse(json);
    if (!line.success) {
      log("clipboard watch").error(`unreadable line: ${text.slice(0, 80)}`);
      return;
    }
    const data = line.data;
    if ("ready" in data) {
      // Ready is not proof it works: a script denied the clipboard dies right after it.
      this.readyAt = Date.now();
      this.status = { state: "watching", detail: null };
    } else if ("tooLarge" in data)
      log("clipboard watch").error(`a copied image of ${data.tooLarge} bytes is too large`);
    else {
      const bytes = Uint8Array.from(Buffer.from(data.image, "base64"));
      this.saving = this.saving
        .then(() => this.save(bytes))
        .then(
          () => {},
          (err) => log("clipboard watch").error(`not kept: ${errorMessage(err)}`),
        );
    }
  }

  // The script is gone: tried again a few times, then left failed with its last words.
  private ended(detail: string): void {
    this.proc = null;
    if (this.stopped) return;
    const ran = this.readyAt === null ? 0 : Date.now() - this.readyAt;
    if (ran >= (this.opts.stableMs ?? WATCH_STABLE_MS)) this.failures = 0;
    this.failures++;
    this.status = { state: "failed", detail };
    log("clipboard watch").error(detail);
    if (this.failures > WATCH_RETRIES) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (!this.stopped) this.launch();
    }, this.opts.retryMs ?? WATCH_RETRY_MS);
    this.retry.unref?.();
  }
}
