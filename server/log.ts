import { chmodSync, copyFileSync, rmSync, statSync, truncateSync } from "node:fs";
import { type AttributeValue, trace } from "@opentelemetry/api";
import { errorMessage } from "./error-message.ts";

// The server's one log format: `<ISO time> <LEVEL> <scope>: <message> key=value…`, one line per
// event, so `data/server.log` can place a failure in time. Never pass a token or a full URL.
// An Error shows its message (and its stack at error level); anything else, as text.
type Fields = Record<string, unknown>;
type Sink = { log: (line: string) => void; error: (line: string) => void };
type Level = "info" | "warn" | "error";

// A URL's query can carry an OAuth code or a token: every URL in a line keeps only its path.
export const withoutQuery = (text: string) =>
  text.replace(/(\bhttps?:\/\/[^\s?#"']*)[?#][^\s"']*/g, "$1");

const shown = (v: unknown) => {
  const text = withoutQuery(errorMessage(v));
  return /^[^\s"=]+$/.test(text) ? text : JSON.stringify(text);
};

// Keys whose value never goes into a trace, even when a caller passes one by mistake.
const SECRET = /token|secret|password|authorization|cookie|body/i;

// Inside a traced request the line also lands on its span, so `aos trace <id>` shows it in
// place; and the line names the trace, so the log leads to it.
function onSpan(level: Level, scope: string, msg: string, fields: Fields): string | null {
  const span = trace.getActiveSpan();
  const ctx = span?.spanContext();
  // An ended span is a request already answered (a timer it started): no trace to name.
  if (!span?.isRecording() || !ctx || !trace.isSpanContextValid(ctx)) return null;
  const attrs: Record<string, AttributeValue> = {
    level,
    scope,
    msg: withoutQuery(msg).slice(0, 300),
  };
  for (const [k, v] of Object.entries(fields)) {
    if (v == null || SECRET.test(k)) continue;
    attrs[k] =
      typeof v === "number" || typeof v === "boolean"
        ? v
        : withoutQuery(errorMessage(v)).slice(0, 300);
    if (level === "error" && v instanceof Error && v.stack)
      attrs.stack = withoutQuery(v.stack).slice(0, 2048);
  }
  span.addEvent("log", attrs);
  return ctx.traceId;
}

function line(level: Level, scope: string, msg: string, fields: Fields = {}) {
  const traceId = onSpan(level, scope, msg, fields);
  const pairs = Object.entries(fields).flatMap(([k, v]) => (v == null ? [] : [`${k}=${shown(v)}`]));
  if (traceId) pairs.push(`trace=${traceId}`);
  const head = [
    new Date().toISOString(),
    level.toUpperCase(),
    `${scope}:`,
    withoutQuery(msg),
    ...pairs,
  ].join(" ");
  const stack =
    level === "error" ? Object.values(fields).find((v) => v instanceof Error)?.stack : undefined;
  return stack ? `${head}\n${stack}` : head;
}

export function log(scope: string, sink: Sink = console) {
  return {
    info: (msg: string, fields?: Fields) => sink.log(line("info", scope, msg, fields)),
    warn: (msg: string, fields?: Fields) => sink.error(line("warn", scope, msg, fields)),
    error: (msg: string, fields?: Fields) => sink.error(line("error", scope, msg, fields)),
  };
}

// Keeps an append-only log file under `maxBytes`: its content moves to `<path>.1` (0600,
// replacing the last one) and the file is emptied in place. A rename would not do: the writers
// hold the file open, so they would go on filling the renamed one. A writer that opened it to
// append goes on writing at its start; one that did not would leave a hole.
// ponytail: lines written between the copy and the truncate are lost; a rename-and-reopen
// protocol (SIGHUP) if that ever matters.
// The shell creates a log redirect 0644; a log names paths and errors, so it is kept 0600.
// A missing file is no failure; any other one comes back for the caller to report.
export function makePrivate(path: string): Error | null {
  try {
    chmodSync(path, 0o600);
    return null;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? null : (err as Error);
  }
}

export function rotate(path: string, maxBytes: number): boolean {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return false;
  }
  if (size <= maxBytes) return false;
  const kept = `${path}.1`;
  rmSync(kept, { force: true });
  copyFileSync(path, kept);
  chmodSync(kept, 0o600);
  truncateSync(path, 0);
  return true;
}
