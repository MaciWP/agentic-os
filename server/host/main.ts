import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { websocket } from "hono/bun";
import { PROTOCOL } from "../../shared/host-contract.ts";
import { DATA_DIR } from "../config-host.ts";
import { MIGRATIONS_DIR, openDb } from "../db.ts";
import { IDLE_TIMEOUT_S } from "../deadline.ts";
import { executor } from "../features/coordination/adapters.ts";
import { ConsultationRunner } from "../features/coordination/runner.ts";
import { CoordinationStore } from "../features/coordination/store.ts";
import { Listeners } from "../features/terminals/contract.ts";
import { loadLoginEnv, loginEnvLoader } from "../features/terminals/env.ts";
import { markLost } from "../features/terminals/lost.ts";
import { TerminalManager } from "../features/terminals/pty.ts";
import { log } from "../log.ts";
import { acquireProcessLock } from "../process-lock.ts";
import { createHostApp } from "./app.ts";
import { hostPaths, isHostPid, readHostFile, writeHostFile } from "./files.ts";
import { idleWatch, liveConfig, removeIfOwn } from "./host.ts";

// The PTY host: owns every terminal, so they outlive the server. The server starts it
// detached and talks to it over loopback with the token from pty-host.json.

const IDLE_EXIT_MS = 30_000;
const hostLog = log("host");
// Set by the server that starts the host; kept out of the terminals' environment.
const BUILD = process.env.AOS_HOST_BUILD;
delete process.env.AOS_HOST_BUILD;

mkdirSync(DATA_DIR, { recursive: true });
const paths = hostPaths(DATA_DIR);
const releaseLock = acquireProcessLock(paths.lock);
if (!releaseLock) {
  hostLog.error(`another PTY host owns ${DATA_DIR}; exiting`);
  process.exit(3);
}
// Upgrade compatibility: older hosts used a PID lock rather than flock.
const previous = readHostFile(paths.file);
if (previous && previous.pid !== process.pid && (await isHostPid(previous.pid))) {
  releaseLock();
  hostLog.error("An existing PTY host must finish before this host can replace it.");
  process.exit(3);
}
const ownsFile = (text: string) => JSON.parse(text).pid === process.pid;
const cleanup = () => {
  removeIfOwn(paths.file, ownsFile);
  releaseLock?.();
};

// Closed on the way out, also when startup fails after opening it.
let db: ReturnType<typeof openDb> | undefined;
try {
  const config = liveConfig(join(DATA_DIR, "config.json"));
  // The server migrates before it starts the host; the host only checks.
  db = openDb(join(DATA_DIR, "agentic-os.db"), MIGRATIONS_DIR, "check");
  const lost = markLost(db);
  const env = loginEnvLoader(() => loadLoginEnv(config().terminals.shell));
  env().catch(() => {});
  const terminals = new TerminalManager(config, db, env);
  const coordinationChanges = new Listeners();
  const consultations = new ConsultationRunner(
    new CoordinationStore(db, () => coordinationChanges.notify()),
    executor(config, env),
  );
  consultations.recover();

  const token = randomBytes(32).toString("base64url");
  let servers = 0;
  const exit = async (code: number) => {
    await consultations.stopAll();
    await terminals.stopAll();
    db?.close();
    cleanup();
    process.exit(code);
  };
  const app = createHostApp(terminals, token, {
    consultations,
    subscribeCoordination: (listener) => {
      coordinationChanges.add(listener);
    },
    control: (connected) => {
      servers += connected ? 1 : -1;
    },
    shutdown: () => void exit(0),
    build: BUILD,
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // A wait holds its request up to MAX_WAIT_MS without sending a byte.
    idleTimeout: IDLE_TIMEOUT_S,
    fetch: app.fetch,
    websocket: { ...websocket, maxPayloadLength: 256 * 1024 },
  });
  writeHostFile(paths.file, {
    port: server.port ?? 0,
    token,
    pid: process.pid,
    protocol: PROTOCOL,
    build: BUILD,
  });
  hostLog.info(
    `PTY host ${process.pid} on 127.0.0.1:${server.port}, protocol ${PROTOCOL}, build ${BUILD ?? "unknown"}`,
  );

  // The agents the last host lost come back on their own (ADR 0008).
  void terminals.resumeLost(lost);

  const running = () =>
    consultations.running() > 0 || terminals.list().some((t) => t.state === "running");
  idleWatch(
    () => servers > 0 || running(),
    IDLE_EXIT_MS,
    () => {
      hostLog.info("no server and no running terminal; exiting");
      void exit(0);
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void exit(0));
} catch (err) {
  hostLog.error("startup failed", { err });
  db?.close();
  cleanup();
  process.exit(1);
}
