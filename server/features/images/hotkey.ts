import { chmod, lstat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { MAX_PASTE_IMAGE_BYTES } from "../../../shared/terminals.ts";
import { errorMessage } from "../../error-message.ts";
import { log } from "../../log.ts";
import { run } from "../../run.ts";
import { helperApp, type MacRunner } from "../mac/run.ts";
import { runCapture } from "./capture.ts";

// ⌃⌘4 anywhere on the Mac. AgenticCapture.app stays running (`hotkey`, see
// scripts/mac/AgenticCapture.swift): on the keys it takes a selection into CAPTURE_DIR, hands
// the file's name to POST /api/images/hotkey/shot and shows the answer for 2 s. It reports its
// state to POST /api/images/hotkey/state and ends with the server. Started by the production
// hub on macOS only, unless images.captureHotkey is false: macOS lets two helpers hold the same
// keys, so there must be one.

export type HotkeyState = {
  state:
    | "off"
    | "starting"
    | "ready"
    | "capturing"
    | "taken"
    | "denied"
    | "not_inherited"
    | "not_installed"
    | "failed";
  detail: string | null;
};

// What the helper says of itself.
export const HotkeyReport = z.strictObject({
  state: z.enum(["ready", "capturing", "taken", "denied", "not_inherited", "failed"]),
  pid: z.number().int().positive(),
  detail: z.string().max(500).optional(),
});
export type HotkeyReport = z.infer<typeof HotkeyReport>;

// The helper writes here, the server reads and empties it. The user's temp folder, never
// data/: the repo may sit under Desktop, which macOS guards per app.
export const CAPTURE_DIR = join(tmpdir(), "agentic-os-captures");
// A capture the helper hands over: a name it picked, never a path. JPEG bytes may come under
// it (the helper shrinks a large one), so the bytes say the type.
export const SHOT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/;

// An `open -W` that ended on its own is started again this many times, this far apart. A
// helper that ran this long before ending was working: its end starts a fresh count.
export const HOTKEY_RETRIES = 3;
export const HOTKEY_RETRY_MS = 5000;
export const HOTKEY_STABLE_MS = 60_000;
// A stopped helper has this long to end before the next one starts.
const STOP_WAIT_MS = 3000;
const GRANT_TIMEOUT_MS = 35_000;
const APP = "AgenticCapture";
const EXECUTABLE = `/${APP}.app/Contents/MacOS/${APP}`;
const SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

export type HotkeySpawn = (argv: string[]) => { exited: Promise<number | null> };
const bunSpawn: HotkeySpawn = (argv) =>
  Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });

// The pid the helper reported, only if it is that app: any local process may post a state.
async function stopHelper(pid: number) {
  const ps = await run(["/bin/ps", "-p", String(pid), "-o", "comm="], { timeoutMs: 5000 });
  if (ps.code !== 0 || !ps.stdout.trim().endsWith(EXECUTABLE)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
}

// A real folder of this user's, private: a link or a file in its place is refused.
async function prepare(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const s = await lstat(dir);
  if (!s.isDirectory() || s.uid !== process.getuid?.())
    throw new Error(`${dir} is not a folder of this user`);
  await chmod(dir, 0o700);
}

export class CaptureHotkey {
  readonly dir: string;
  private status: HotkeyState = { state: "off", detail: null };
  private stopped = true;
  // Each `open` has a number; the end of one that was replaced or stopped is ignored.
  private launch = 0;
  private exited: Promise<unknown> | null = null;
  private pid: number | null = null;
  private failures = 0;
  private takenAgain = false;
  private readyAt: number | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly opts: {
      port: number;
      dir?: string;
      spawn?: HotkeySpawn;
      stop?: (pid: number) => Promise<void>;
      helper?: MacRunner;
      openSettings?: () => Promise<unknown>;
      pid?: number;
      retryMs?: number;
      stableMs?: number;
    },
  ) {
    this.dir = opts.dir ?? CAPTURE_DIR;
  }

  state(): HotkeyState {
    return this.status;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.failures = 0;
    this.takenAgain = false;
    void this.open();
  }

  stop(): void {
    this.stopped = true;
    this.end();
    this.status = { state: "off", detail: null };
  }

  // The helper's own word, taken only from the one this server started and is waiting on.
  report(r: HotkeyReport): boolean {
    if (this.stopped || !this.exited || (this.pid !== null && this.pid !== r.pid)) return false;
    this.pid = r.pid;
    this.status = { state: r.state, detail: r.detail ?? null };
    if (r.state === "ready") this.readyAt ??= Date.now();
    if (r.state !== "failed" && r.state !== "not_inherited")
      log("capture hotkey").info(`helper ${r.pid}: ${r.state}`);
    else log("capture hotkey").error(`helper ${r.pid}: ${r.state} ${r.detail ?? ""}`);
    return true;
  }

  // A shot was kept: the helper says nothing more until the next press.
  settled(): void {
    if (this.status.state === "capturing") this.status = { state: "ready", detail: null };
  }

  // "Conceder permiso": macOS's own request the first time, System Settings after that. A
  // running helper keeps the answer it read at launch, so a grant starts a new one.
  async grant(): Promise<{ granted: boolean }> {
    const answer = z
      .object({ granted: z.boolean() })
      .parse(await (this.opts.helper ?? runCapture)(["grant"], GRANT_TIMEOUT_MS));
    const settings = () => run(["open", SETTINGS], { timeoutMs: 10_000 });
    if (!answer.granted) await (this.opts.openSettings ?? settings)();
    else if (!this.stopped) {
      const exited = this.exited;
      this.end();
      if (exited) await Promise.race([exited, Bun.sleep(STOP_WAIT_MS)]);
      this.failures = 0;
      this.takenAgain = false;
      if (!this.stopped) void this.open();
    }
    return answer;
  }

  private end(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.launch++;
    this.exited = null;
    const pid = this.pid;
    this.pid = null;
    if (pid !== null) void (this.opts.stop ?? stopHelper)(pid).catch(() => {});
  }

  private async open(): Promise<void> {
    const launch = ++this.launch;
    this.pid = null;
    this.readyAt = null;
    this.status = { state: "starting", detail: null };
    try {
      await prepare(this.dir);
      if (launch !== this.launch || this.stopped) return;
      const argv = [
        "open",
        "-n",
        "-g",
        "-W",
        "-a",
        helperApp(APP),
        "--args",
        "hotkey",
        String(this.opts.pid ?? process.pid),
        `http://127.0.0.1:${this.opts.port}`,
        this.dir,
        String(MAX_PASTE_IMAGE_BYTES),
      ];
      const exited = (this.opts.spawn ?? bunSpawn)(argv).exited;
      this.exited = exited;
      void exited.then(
        (code) => this.ended(launch, code),
        (err) => this.ended(launch, null, errorMessage(err)),
      );
    } catch (err) {
      this.ended(launch, null, `could not start: ${errorMessage(err)}`);
    }
  }

  // The helper is gone. `open` fails when the app is missing; keys the system refused are
  // tried once more; anything else is started again a few times, then left failed.
  private ended(launch: number, code: number | null, detail?: string): void {
    if (launch !== this.launch) return;
    this.exited = null;
    this.pid = null;
    if (this.stopped) return;
    if (code !== null && code !== 0) {
      this.status = {
        state: "not_installed",
        detail: `run \`bun run mac:build ${APP}\` to build ${APP}.app`,
      };
      log("capture hotkey").error(`open exited ${code}: ${APP}.app is missing`);
      return;
    }
    if (this.status.state === "taken") {
      if (this.takenAgain) return;
      this.takenAgain = true;
    } else {
      const ran = this.readyAt === null ? 0 : Date.now() - this.readyAt;
      if (ran >= (this.opts.stableMs ?? HOTKEY_STABLE_MS)) this.failures = 0;
      this.failures++;
      this.status = { state: "failed", detail: detail ?? "the helper ended" };
      log("capture hotkey").error(this.status.detail ?? "");
      if (this.failures > HOTKEY_RETRIES) return;
    }
    this.retry = setTimeout(() => {
      this.retry = null;
      if (!this.stopped && launch === this.launch) void this.open();
    }, this.opts.retryMs ?? HOTKEY_RETRY_MS);
    this.retry.unref?.();
  }
}
