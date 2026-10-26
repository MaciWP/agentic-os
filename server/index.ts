import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { createApp } from "./app.ts";
import { DATA_DIR, loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { IDLE_TIMEOUT_S } from "./deadline.ts";
import { serverRoot } from "./deps.ts";
import { log } from "./log.ts";
import { acquireProcessLock } from "./process-lock.ts";
import { readyGate } from "./ready.ts";
import { remoteGuard } from "./remote-access.ts";
import { withSpa } from "./static.ts";
import { startTelemetry } from "./telemetry/index.ts";

// Own both the data directory and the port before opening/migrating/recovering data.
mkdirSync(DATA_DIR, { recursive: true });
const release = acquireProcessLock(join(DATA_DIR, "server.lock"));
if (!release) {
  log("server").error("another Agentic OS server owns this data directory");
  process.exit(3);
}
const gate = readyGate();
let server: ReturnType<typeof Bun.serve> | undefined;
let remoteServer: ReturnType<typeof Bun.serve> | undefined;
// Closed on the way out, also when startup fails after opening it.
let db: ReturnType<typeof openDb> | undefined;
let telemetry: ReturnType<typeof startTelemetry> = null;
let api: ReturnType<typeof createApp> | undefined;
// Set once the app serves; a restart asked for earlier is answered 503 and never gets here.
let quiesce = () => {};
let stop = async () => {};
try {
  const config = loadConfig();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: config.port,
    idleTimeout: IDLE_TIMEOUT_S,
    fetch: gate.fetch,
    websocket: { ...websocket, maxPayloadLength: 256 * 1024 },
  });
  if (config.remote.enabled) {
    if (config.remote.port === config.port)
      throw new Error("remote port must differ from local port");
    const ingress = new Hono()
      .use("*", remoteGuard(config.remote))
      .all("*", (c) => gate.fetch(c.req.raw, c.env));
    remoteServer = Bun.serve({
      hostname: "127.0.0.1",
      port: config.remote.port,
      fetch: ingress.fetch,
      idleTimeout: IDLE_TIMEOUT_S,
      websocket: { ...websocket, maxPayloadLength: 256 * 1024 },
    });
  }
  db = openDb(join(DATA_DIR, "agentic-os.db"));
  // Its own file and writer (server/telemetry); null when TELEMETRY=off or it cannot open.
  telemetry = startTelemetry(DATA_DIR, "server");
  // Every service and its background work comes from the one composition root (deps.ts).
  api = createApp(serverRoot(config, db, { quiesce: () => quiesce(), stop: () => stop() }));
  const root = process.env.AOS_DIST ?? join(import.meta.dir, "..", "dist");
  const app = withSpa(api, root);
  api.start();
  gate.serve(app);
  let stopping = false;
  // Answers 503 from here on and ends the background work; a restart stops the host after it.
  quiesce = () => {
    gate.quiesce();
    api?.dispose();
  };
  stop = async () => {
    if (stopping) return;
    stopping = true;
    quiesce();
    await remoteServer?.stop(true);
    await server?.stop(true);
    // Last: nothing else runs after it but the exit. Never stop the independent PTY host here.
    telemetry?.close();
    db?.close();
    release();
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void stop());
  log("server").info(`Agentic OS on http://localhost:${server.port}`);
} catch (err) {
  log("server").error("startup failed", { err });
  api?.dispose();
  await remoteServer?.stop(true);
  await server?.stop(true);
  db?.close();
  release();
  process.exit(1);
}
