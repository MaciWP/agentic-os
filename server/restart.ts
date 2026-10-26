import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HostFile } from "../shared/host-contract.ts";
import { errorMessage } from "./error-message.ts";
import { commandLine, run } from "./run.ts";

// A restart asked for from the app, also from a remote device with nobody at the Mac. The
// supervisor (scripts/supervise.ts) starts the server again whenever it exits 0, and that
// server starts a fresh PTY host when the old one is gone. So this server only has to stop
// cleanly, after the host for a full restart. Every check that could keep it from coming back
// runs first: once it exits, a broken start means a trip to the Mac.

export type RestartScope = "server" | "all";

export type RestartDeps = {
  // The live supervisor is this process's parent: someone starts it again.
  supervised: () => boolean | Promise<boolean>;
  // Why the next start would fail (config, code), or null.
  preflight: () => Promise<string | null>;
  // Stops answering and disposes the background work, without exiting: a half-stopped server
  // must not start a host of its own once the old one goes.
  quiesce: () => void;
  hostPid: () => number | null;
  isHostPid: (pid: number) => Promise<boolean>;
  // Asks the host to stop what runs and exit, leaving it for the next host to resume; false
  // when it refused (an older host on Windows), so nobody waits for it.
  stopHost: (pid: number) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  // Builds the page from the current code into dist/, unless dist/ already is: whether it
  // built, or why it could not. Only a full restart asks for it, so "Reiniciar todo" leaves
  // nothing of the old code running.
  rebuildWeb: () => Promise<{ built: boolean } | { failed: string }>;
  // Closes the listeners, releases the lock and exits 0.
  exit: () => Promise<void>;
  log: (line: string) => void;
};

const HOST_STOP_MS = 10_000;
// Long enough for the 202 to leave before the listeners close.
const REPLY_MS = 200;

export class Restarter {
  private pending = false;

  constructor(
    private readonly deps: RestartDeps,
    private readonly hostStopMs = HOST_STOP_MS,
  ) {}

  // Why nobody would start this server again, or null: checked before anything that needs
  // the restart that follows (an update) touches the disk.
  async unsupervised(): Promise<string | null> {
    return (await this.deps.supervised())
      ? null
      : "el servidor no corre bajo el supervisor: nadie lo volvería a arrancar";
  }

  // Null once the restart is under way; otherwise why it was refused, with nothing touched.
  async start(scope: RestartScope): Promise<string | null> {
    if (this.pending) return "ya hay un reinicio en marcha";
    this.pending = true;
    const unsupervised = await this.unsupervised();
    if (unsupervised) {
      this.pending = false;
      return unsupervised;
    }
    const reason = await this.deps
      .preflight()
      .catch((err: Error) => `no se ha podido comprobar el arranque: ${err.message}`);
    if (reason) {
      this.pending = false;
      return reason;
    }
    setTimeout(() => void this.run(scope), REPLY_MS);
    return null;
  }

  private async run(scope: RestartScope) {
    const { deps } = this;
    deps.log(`restart: ${scope === "all" ? "server and PTY host" : "server"}`);
    const host = scope === "all" ? deps.hostPid() : null;
    if (scope === "all") {
      // While it still serves: a failed build keeps the old page, never a half-built one.
      const outcome = await deps.rebuildWeb().catch((err: Error) => ({ failed: err.message }));
      deps.log(
        "failed" in outcome
          ? `restart: web not rebuilt, the old one stays: ${outcome.failed}`
          : outcome.built
            ? "restart: web rebuilt"
            : "restart: web already current",
      );
    }
    deps.quiesce();
    if (host !== null && (await deps.isHostPid(host))) {
      // The server comes back anyway: it keeps a live host as stale, and stays reachable.
      if (!(await deps.stopHost(host))) deps.log(`restart: PTY host ${host} refused to stop; kept`);
      else {
        const end = Date.now() + this.hostStopMs;
        while ((await deps.isHostPid(host)) && Date.now() < end) await deps.sleep(100);
        if (await deps.isHostPid(host)) deps.log(`restart: PTY host ${host} did not stop; kept`);
      }
    }
    await deps.exit();
  }
}

// scripts/refresh.ts, the same build `bun run refresh` makes: 3 to 19 s when the page's
// sources changed, under a second when dist/ is already built from them.
export async function rebuildWeb(
  appRoot: string,
): Promise<{ built: boolean } | { failed: string }> {
  const built = await run([process.execPath, join(appRoot, "scripts/refresh.ts")], {
    cwd: appRoot,
    timeoutMs: 120_000,
  });
  if (built.code === 0) return { built: !built.stdout.includes("dist/ is current") };
  if (built.timedOut) return { failed: "the build took over 2 minutes" };
  return {
    failed: built.stderr.trim().split("\n").slice(-3).join(" ") || `exit ${built.code}`,
  };
}

// The host's own clean exit, asked over its loopback API because Windows has no SIGTERM. A
// host from before `force` refuses while busy (409); POSIX then falls back to the signal, and
// on Windows that host is kept until its terminals end.
export async function stopHost(
  host: HostFile,
  signal: (pid: number) => unknown = (pid) => process.kill(pid, "SIGTERM"),
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const res = await fetch(`http://127.0.0.1:${host.port}/shutdown?force=1`, {
    method: "POST",
    headers: { authorization: `Bearer ${host.token}` },
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined);
  if (res?.ok) return true;
  if (platform === "win32") return false;
  try {
    signal(host.pid);
  } catch {
    // Already gone.
  }
  return true;
}

// The supervisor writes its pid; a stale file never passes for a parent that is gone. It also
// hands its pid to the server it starts: Windows has no reliable parent pid.
export const SUPERVISOR_ENV = "AOS_SUPERVISOR_PID";
export async function supervisedBy(
  pidFile: string,
  ppid = Number(process.env[SUPERVISOR_ENV]) || process.ppid,
): Promise<boolean> {
  let pid: number;
  try {
    pid = Number(readFileSync(pidFile, "utf8").trim());
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid !== ppid) return false;
  return (await commandLine(pid)).includes("scripts/supervise.ts");
}

// What would keep the next start from coming up: a config.json that no longer parses, or code
// that does not compile (syntax, a missing file). Packages stay out of the bundle: only the
// app's own files are read.
export async function startupProblem(appRoot: string, loadConfig: () => unknown) {
  try {
    loadConfig();
  } catch (err) {
    return `config.json no es válido: ${errorMessage(err)}`;
  }
  const built = await Bun.build({
    entrypoints: [join(appRoot, "server/index.ts"), join(appRoot, "server/host/main.ts")],
    target: "bun",
    packages: "external",
    throw: false,
  });
  if (!built.success)
    return `el código no compila: ${built.logs.map((l) => l.message).join("; ") || "sin detalle"}`;
  return null;
}
