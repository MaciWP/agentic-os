import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Health, type HostFile, PROTOCOL } from "../../shared/host-contract.ts";
import { HostUnavailable } from "../features/terminals/host-client.ts";
import { importGraph } from "../import-graph.ts";
import { log } from "../log.ts";
import { type FoundHost, hostPaths, isHostPid, readHostFile } from "./files.ts";

const HOST_ENTRY = join(import.meta.dir, "main.ts");
const START_TIMEOUT_MS = 10_000;
// How long an idle host being replaced has to answer its shutdown and exit.
const STOP_TIMEOUT_MS = 3000;
// main.ts exits with this when another host already owns the data dir.
const LOST_LOCK = 3;

const LOCKFILE = join(import.meta.dir, "..", "..", "bun.lock");

// The code a host started from `entry` would run: every file it reaches through relative
// imports, plus the lockfile for the packages. The host runs from source, so an edit to
// any of them under the same PROTOCOL still means another build.
export function hostBuild(entry = HOST_ENTRY, lockfile = LOCKFILE): string {
  const hash = createHash("sha256");
  for (const file of importGraph(entry)) hash.update(`${file}\0${readFileSync(file, "utf8")}\0`);
  try {
    hash.update(readFileSync(lockfile));
  } catch {}
  return hash.digest("hex").slice(0, 16);
}

// What to do with the host found. Same protocol and build: use it. Anything else is replaced
// once nothing runs in it. With terminals running, a host of the same protocol still speaks
// to this server, so it is used until a restart finds it idle; an older protocol cannot be.
export function verdict(seen: Health | undefined, build: string) {
  if (!seen) return "start";
  if (seen.protocol === PROTOCOL && seen.build === build) return "use";
  if (seen.running === 0) return "replace";
  return seen.protocol === PROTOCOL ? "use-stale" : "refuse";
}

export async function health(host: HostFile): Promise<Health | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${host.port}/health`, {
      headers: { authorization: `Bearer ${host.token}` },
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return undefined;
    const seen = Health.safeParse(await res.json());
    return seen.success ? seen.data : undefined;
  } catch {
    return undefined;
  }
}

// The PTY host of this data dir: the one already running if it speaks this protocol,
// otherwise a new one, started detached (its own session, so Ctrl+C on the server never
// reaches it). An older host still running terminals is never replaced.
export async function connectHost(
  dataDir: string,
  {
    entry = HOST_ENTRY,
    env = process.env as Record<string, string | undefined>,
    build = hostBuild(entry),
    stopMs = STOP_TIMEOUT_MS,
  } = {},
): Promise<FoundHost> {
  const paths = hostPaths(dataDir);
  const found = readHostFile(paths.file);
  const seen = found ? await health(found) : undefined;
  const next = verdict(seen, build);
  if (found && next === "use") return found;
  if (found && seen && next === "use-stale") {
    log("PTY host").warn(
      `${seen.pid} runs build ${seen.build ?? "unknown"}, not ${build}; it is kept while its ${seen.running} terminal(s) run. «Reiniciar todo» in the system panel loads it; Claude, Codex and Grok resume.`,
    );
    return { ...found, stale: true };
  }
  if (found && seen) {
    if (next === "refuse")
      throw new HostUnavailable(
        `an older PTY host (pid ${seen.pid}, protocol ${seen.protocol}) still runs ${seen.running} terminal(s); stop them so it can be replaced`,
      );
    const end = Date.now() + stopMs;
    await fetch(`http://127.0.0.1:${found.port}/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${found.token}` },
      signal: AbortSignal.timeout(stopMs),
    }).catch(() => undefined);
    while ((await isHostPid(seen.pid)) && Date.now() < end) await Bun.sleep(50);
    // Two hosts on one data dir would fight over it; the old one is never killed from here.
    if (await isHostPid(seen.pid))
      throw new HostUnavailable(
        `the old PTY host (pid ${seen.pid}) did not stop in ${stopMs / 1000} s; stop it and try again`,
      );
  }

  const logFile = openSync(paths.log, "a", 0o600);
  const proc = Bun.spawn([process.execPath, entry], {
    detached: true,
    stdio: ["ignore", logFile, logFile],
    env: { ...env, AOS_HOST_BUILD: build },
  });
  closeSync(logFile);
  proc.unref();
  let exitCode: number | undefined;
  void proc.exited.then((code) => {
    exitCode = code;
  });

  // Another server may have started a host at the same moment: whichever wins the lock
  // writes the file, and both use it.
  const end = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < end) {
    if (exitCode !== undefined && exitCode !== LOST_LOCK)
      throw new HostUnavailable(`PTY host exited with ${exitCode}; see ${paths.log}`);
    const host = readHostFile(paths.file);
    if (host && host.pid !== found?.pid && verdict(await health(host), build) === "use")
      return host;
    await Bun.sleep(50);
  }
  throw new HostUnavailable(
    `PTY host did not start in ${START_TIMEOUT_MS / 1000} s; see ${paths.log}`,
  );
}
