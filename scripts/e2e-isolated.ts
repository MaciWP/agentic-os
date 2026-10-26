// e2e-isolated: the one e2e server every session shares, on 4318, never the user's 4317.
// One run at a time (a lock under data/e2e/), with its own build and data there, and
// whatever it started is stopped at the end, its PTY host included. The arguments go to
// Playwright as given: bun run e2e:isolated e2e/grid.e2e.ts --project main
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import { hostPaths, isHostPid, readHostFile } from "../server/host/files.ts";
import { errorGroups, openTelemetry, telemetryPath } from "../server/telemetry/store.ts";
import { lock } from "./lock.ts";

const ROOT = join(import.meta.dir, "..");
const BASE = join(ROOT, "data", "e2e");
const DATA = join(BASE, "data");
// Server errors are summed from here on (the traces of earlier runs stay in the file).
const STARTED = Date.now();
const DIST = join(BASE, "dist");
// The screenshots folder the image tests seed, never the user's own.
const SHOTS = join(BASE, "shots");
// The server's pid while a run holds the lock.
const SERVER_PID = join(BASE, "server.pid");
// "Abrir carpeta" runs this editor: it only writes the folder it gets to EDITOR_LOG, which
// rename.e2e.ts reads. The server spawns it with the login env, so the path is in the script.
const EDITOR = join(BASE, "editor.sh");
const EDITOR_LOG = join(BASE, "editor.log");
// A fake llama-server: the run never starts the PC's engine, whatever the user's `ai` says.
const ENGINE = join(ROOT, "e2e", "fixtures", "fake-llama.ts");
const ENGINE_PORT = 4328;
const PORT = 4318;
const URL = `http://localhost:${PORT}`;

// The machine's load, said at both ends of a run: a red under load reads apart from a regression.
const load = (when: string) =>
  `e2e:isolated: ${when} ${new Date().toISOString()}, load ${loadavg()
    .map((n) => n.toFixed(2))
    .join(" ")}\n`;

const answers = () =>
  fetch(`${URL}/api/health`, {
    signal: AbortSignal.timeout(1000),
    headers: { host: `localhost:${PORT}` },
  }).then(
    (response) => response.ok,
    () => false,
  );

async function stopHost() {
  const host = readHostFile(hostPaths(DATA).file);
  if (!host || !(await isHostPid(host.pid))) return;
  await fetch(`http://127.0.0.1:${host.port}/shutdown`, {
    method: "POST",
    headers: { authorization: `Bearer ${host.token}` },
  }).catch(() => undefined);
  const end = Date.now() + 3000;
  while ((await isHostPid(host.pid)) && Date.now() < end) await Bun.sleep(50);
  if (await isHostPid(host.pid)) process.kill(host.pid);
}

// A run killed without its cleanup (SIGKILL, a tool's timeout) leaves its server and PTY host
// behind, and every later run then fails on a taken port. Holding the lock, a run stops them,
// once `ps` shows the pid is still that server: on this data dir, never the user's.
async function stopOrphan() {
  let pid = Number.NaN;
  try {
    pid = Number(readFileSync(SERVER_PID, "utf8"));
  } catch {}
  rmSync(SERVER_PID, { force: true });
  const ps = Bun.spawnSync(["ps", "eww", "-o", "command=", "-p", String(pid)], { env: {} });
  if (!Number.isInteger(pid) || !ps.stdout.toString().includes(`AGENTIC_OS_DATA=${DATA} `)) return;
  console.error(`e2e:isolated: stopping server ${pid}, left by a run that did not clean up`);
  process.kill(pid, "SIGTERM");
  const end = Date.now() + 5000;
  while ((await answers()) && Date.now() < end) await Bun.sleep(100);
  await stopHost();
}

mkdirSync(DATA, { recursive: true });
mkdirSync(SHOTS, { recursive: true });
const release = await lock(join(BASE, "run.lock"), "e2e:isolated");
const start = load("start");
process.stderr.write(start);
let server: ReturnType<typeof Bun.spawn> | undefined;
const cleanup = async () => {
  server?.kill();
  await server?.exited;
  await stopHost();
  rmSync(SERVER_PID, { force: true });
  release();
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => void cleanup().then(() => process.exit(130)));

let code = 1;
try {
  await stopOrphan();
  if (await answers())
    throw new Error(`${URL} is already taken by a server this run did not start; stop it first`);
  const build = Bun.spawnSync(["bunx", "vite", "build", "--outDir", DIST, "--emptyOutDir"], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (build.exitCode !== 0) throw new Error("the build failed");

  // The user's config, on this port. A data dir of its own: its DB, notes and PTY host.
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(readFileSync(join(ROOT, "data", "config.json"), "utf8"));
  } catch {}
  writeFileSync(EDITOR, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${EDITOR_LOG}'\n`, { mode: 0o755 });
  // The user's server already holds ⌃⌘4.
  const images = { screenshotsDir: SHOTS, captureHotkey: false };
  writeFileSync(
    join(DATA, "config.json"),
    JSON.stringify(
      {
        ...config,
        port: PORT,
        images,
        remote: { enabled: false },
        terminals: {
          ...((config.terminals as object) ?? {}),
          editor: EDITOR,
          // A launch in «Carpeta libre» stays inside the throwaway data folder.
          scratch: join(DATA, "scratch"),
        },
        git: { ...((config.git as object) ?? {}), autoUpdateMinutes: 0 },
        // It reads the user's real Log Pose logs: the Monday judge pass would be a real spend.
        usage: { ...((config.usage as object) ?? {}), judgeAuto: false },
        ai: { engine: { bin: ENGINE, model: ENGINE, port: ENGINE_PORT, idleMinutes: 1 } },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  const log = openSync(join(BASE, "server.log"), "w", 0o600);
  writeSync(log, start);
  server = Bun.spawn(["bun", "server/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      AGENTIC_OS_DATA: DATA,
      AOS_DIST: DIST,
      NODE_ENV: "production",
      // Few requests, each one worth its trace when a test fails.
      TELEMETRY: "full",
    },
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  writeFileSync(SERVER_PID, String(server.pid));
  const ready = Date.now() + 20_000;
  while (!(await answers())) {
    if (Date.now() > ready || server.exitCode !== null)
      throw new Error(`the e2e server did not start; see ${join(BASE, "server.log")}`);
    await Bun.sleep(200);
  }

  const run = Bun.spawn(["bunx", "playwright", "test", ...process.argv.slice(2)], {
    cwd: ROOT,
    env: { ...process.env, AOS_E2E_URL: URL, AOS_E2E_SHOTS: SHOTS, AOS_E2E_EDITOR_LOG: EDITOR_LOG },
    stdio: ["inherit", "inherit", "inherit"],
  });
  code = await run.exited;
} catch (err) {
  console.error(`e2e:isolated: ${(err as Error).message}`);
} finally {
  await cleanup();
  const end = load(`end (exit ${code})`);
  process.stderr.write(end);
  // Once the server has stopped, since it writes at the offset the start line left.
  if (server) appendFileSync(join(BASE, "server.log"), end);
  if (server) serverErrors();
}

// The server's failures during this run, from its traces (written on its way out): the lead
// to follow when a test fails on a 5xx. `AGENTIC_OS_DATA=data/e2e/data aos trace <id>` opens one.
function serverErrors() {
  try {
    const db = openTelemetry(telemetryPath(DATA, "server"), true);
    const groups = errorGroups(db, STARTED);
    db.close();
    if (!groups.length) return;
    process.stderr.write(
      `e2e:isolated: server errors in this run (AGENTIC_OS_DATA=${DATA} bin/aos trace <id>):\n`,
    );
    for (const g of groups)
      process.stderr.write(`  ${g.count}× ${g.name} · ${g.error} · trace ${g.trace}\n`);
  } catch (err) {
    process.stderr.write(`e2e:isolated: no trace summary: ${(err as Error).message}\n`);
  }
}
process.exit(code);
