// supervise: keeps the production server running for start-agentic-os.command. A clean exit
// (0: the server stopped on SIGTERM, which is how 4317 is restarted) starts the current code at
// once; a crash restarts after a growing wait, up to a minute, and it never gives up: a remote
// device has no one at the Mac to start it again. A busy lock (exit 3: another server owns the
// data, such as one started by hand) is waited out: once that server is gone this one starts
// again. Only a stop sent to the supervisor ends supervision. It runs from Terminal.app,
// never launchd: macOS blocks background agents from reading ~/Desktop.
// The PTY host outlives a server crash, so the restarted server reattaches its terminals.
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_ROOT, DATA_DIR, loadConfig } from "../server/config.ts";
import { AWAKE_ENV, remoteHold } from "../server/features/system/keep-awake.ts";
import { afterExit, beforeStart, UPDATES_ENV } from "../server/features/system/update.ts";
import { hostPaths, isHostPid, readHostFile } from "../server/host/files.ts";
import { log } from "../server/log.ts";
import { acquireProcessLock } from "../server/process-lock.ts";
import { SUPERVISOR_ENV } from "../server/restart.ts";
import { run } from "../server/run.ts";

export type Exit = { code: number | null; ms: number };

const LOCK_BUSY = 3;
// A server that ran this long was not crash-looping: the wait starts over.
const STABLE_MS = 60_000;
const FIRST_WAIT_MS = 1_000;
const MAX_WAIT_MS = 60_000;
const LOCK_POLL_MS = 5_000;

export async function supervise(deps: {
  start: () => Promise<Exit>;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  stopped: () => boolean;
  lockFree: () => boolean;
}): Promise<number> {
  let crashes = 0;
  while (!deps.stopped()) {
    const exit = await deps.start();
    if (deps.stopped()) return 0;
    if (exit.code === 0) {
      crashes = 0;
      deps.log("server stopped; starting it again");
      continue;
    }
    if (exit.code === LOCK_BUSY) {
      deps.log("another server owns the data directory; waiting for it to stop");
      while (!deps.lockFree()) {
        await deps.sleep(LOCK_POLL_MS);
        if (deps.stopped()) return 0;
      }
      crashes = 0;
      continue;
    }
    crashes = exit.ms >= STABLE_MS ? 1 : crashes + 1;
    const wait = Math.min(FIRST_WAIT_MS * 2 ** (crashes - 1), MAX_WAIT_MS);
    deps.log(`server exited (${exit.code ?? "signal"}); restarting in ${wait} ms`);
    await deps.sleep(wait);
  }
  return 0;
}

if (import.meta.main) {
  const pidFile = join(DATA_DIR, "supervisor.pid");
  let stopping = false;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let running = false;
  // Terminal closing its window sends SIGHUP; nohup ignores it, so only a stop request ends this.
  // A stop during a wait ends at once: the launcher gives each process 10 s to go.
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      stopping = true;
      if (running) child?.kill("SIGTERM");
      else {
        rmSync(pidFile, { force: true });
        process.exit(0);
      }
    });
  writeFileSync(pidFile, `${process.pid}\n`);
  // Remote availability for as long as this supervisor lives: a server restart leaves no gap in
  // which a Mac with its lid closed falls asleep. Read once; a change needs a supervisor restart.
  const remote = (() => {
    try {
      return loadConfig().remote.enabled;
    } catch {
      return false;
    }
  })();
  const awake =
    process.platform === "darwin" && remote
      ? Bun.spawn(remoteHold(process.pid), { stdio: ["ignore", "ignore", "ignore"] })
      : null;
  const update = {
    appRoot: APP_ROOT,
    dataDir: DATA_DIR,
    hostAlive: async () => {
      const host = readHostFile(hostPaths(DATA_DIR).file);
      return host !== undefined && (await isHostPid(host.pid));
    },
    install: () =>
      run([process.execPath, "install", "--frozen-lockfile"], {
        cwd: APP_ROOT,
        env: process.env as Record<string, string>,
        timeoutMs: 300_000,
      }),
    log: (line: string) => log("supervise").warn(line),
  };
  const code = await supervise({
    start: async () => {
      // An update from the hub: its packages first, and its trial clock from this start.
      await beforeStart(update);
      const began = Date.now();
      child = Bun.spawn([process.execPath, join(APP_ROOT, "server/index.ts")], {
        cwd: APP_ROOT,
        env: {
          ...process.env,
          NODE_ENV: "production",
          [SUPERVISOR_ENV]: String(process.pid),
          [UPDATES_ENV]: "1",
          ...(awake && { [AWAKE_ENV]: "1" }),
        },
        stdio: ["ignore", "inherit", "inherit"],
      });
      running = true;
      const code = await child.exited;
      running = false;
      const exit = { code: child.signalCode ? null : code, ms: Date.now() - began };
      afterExit(update, exit.code);
      return exit;
    },
    sleep: (ms) => Bun.sleep(ms),
    // The server's own format, on stderr as before: every line is a restart or a wait.
    log: (line) => log("supervise").warn(line),
    stopped: () => stopping,
    // Taken and given back at once: a server starting in that instant exits 3 and is waited out.
    lockFree: () => {
      const release = acquireProcessLock(join(DATA_DIR, "server.lock"));
      release?.();
      return release !== null;
    },
  });
  rmSync(pidFile, { force: true });
  process.exit(code);
}
