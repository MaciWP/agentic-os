import type { Database } from "bun:sqlite";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { AlwaysOnSampler, TracerProvider } from "@opentelemetry/sdk-trace";
import { log } from "../log.ts";
import { TailProcessor } from "./processor.ts";
import {
  BUDGET_BYTES,
  openTelemetry,
  prune,
  routeHistos,
  telemetryPath,
  writeBatch,
} from "./store.ts";

// Starts tracing for this process: spans stay in this machine, in `<data>/telemetry.db` (the
// PTY host's in `host-telemetry.db`), read by `aos trace`. Configured here in full: no
// exporter, and no OTEL_* variable changes anything, so nothing can go to localhost:4317/4318,
// which are this app and its e2e server. TELEMETRY=off turns it all off; TELEMETRY=full keeps
// every request whole.

const HOUR = 3_600_000;

export type Telemetry = {
  path: string;
  db: Database;
  processor: TailProcessor;
  // Synchronous: writes what is held, for the last moments before an exit.
  flush: () => void;
  close: () => void;
};

// The running process's telemetry, for its API routes; null when off or not started.
let active: Telemetry | null = null;
export const activeTelemetry = () => active;

export function startTelemetry(dataDir: string, proc: string): Telemetry | null {
  if (process.env.TELEMETRY === "off") return null;
  const path = telemetryPath(dataDir, proc);
  let db: Database;
  try {
    db = openTelemetry(path);
  } catch (err) {
    // Tracing is never a reason for the app not to start.
    log("telemetry").warn("off: the trace file did not open", { path, err });
    return null;
  }
  const processor = new TailProcessor({ proc, write: (s, r, h) => writeBatch(db, s, r, h) });
  // TELEMETRY=full (the e2e server) stores every request whole for the life of the process.
  if (process.env.TELEMETRY === "full") processor.fullUntil = Number.POSITIVE_INFINITY;
  // A start marks its minute: the first minutes after it run cold and `health` leaves them out.
  processor.gauge("start", 0);
  const provider = new TracerProvider({
    sampler: new AlwaysOnSampler(),
    spanLimits: { attributeCountLimit: 64, attributeValueLengthLimit: 1024, eventCountLimit: 32 },
    spanProcessors: [processor],
  });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
  const usual = () => {
    try {
      // Background runs (an ingest, a watcher's gh call) are slow against their own p95 too.
      const from = Date.now() - HOUR;
      processor.usual(new Map([...routeHistos(db, from, "op"), ...routeHistos(db, from)]));
    } catch (err) {
      processor.stats.lastError = String(err);
    }
  };
  const tidy = () => {
    try {
      prune(db, Date.now(), BUDGET_BYTES);
    } catch (err) {
      processor.stats.lastError = String(err);
    }
  };
  // A synchronous stretch (a large JSON, a heavy query) delays every request at once; each
  // request only shows it as its own time. The loop's lateness, per minute, names it.
  const loop = monitorEventLoopDelay({ resolution: 50 });
  loop.enable();
  const lateness = () => {
    if (loop.count) {
      processor.gauge("event loop p99", loop.percentile(99) / 1e6);
      processor.gauge("event loop max", loop.max / 1e6);
    }
    loop.reset();
  };
  const timers = [
    setInterval(usual, 60_000),
    setInterval(lateness, 60_000),
    setInterval(tidy, HOUR),
    setTimeout(tidy, 30_000),
  ];
  for (const t of timers) t.unref?.();
  usual();
  let closed = false;
  const flush = () => {
    if (!closed) processor.write(true);
  };
  // `process.exit` runs only synchronous handlers: the spans of a crash get written here.
  process.on("exit", flush);
  active = {
    path,
    db,
    processor,
    flush,
    close: () => {
      flush();
      closed = true;
      active = null;
      for (const t of timers) clearInterval(t);
      loop.disable();
      void provider.shutdown();
      db.close();
    },
  };
  return active;
}
