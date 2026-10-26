import type { ClientError } from "../server/features/client-errors/routes.ts";
import { ApiError } from "./api.ts";

// A tab's own failures, sent to the server it was loaded from so they land in data/server.log.
// Each distinct one is sent once per tab, and at most MAX_SENT in all: a failure that repeats
// on every render must not turn into a flood of reports.
const MAX_SENT = 20;
const sent = new Set<string>();

export function reportError(kind: ClientError["kind"], error: unknown, where?: string) {
  const err = error instanceof Error ? error : new Error(String(error));
  const message = `${where ? `${where}: ` : ""}${err.message || err.name}`.slice(0, 500);
  const key = `${kind} ${message}`;
  if (sent.has(key) || sent.size >= MAX_SENT) return;
  sent.add(key);
  const body: ClientError = {
    kind,
    message,
    stack: err.stack?.slice(0, 4000),
    path: (globalThis.location?.pathname ?? "/").slice(0, 200),
    request: (error instanceof ApiError && error.requestId) || undefined,
  };
  // Its own failure is dropped: reporting it would only fail the same way.
  fetch("/api/client-errors", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {});
}

// What no code caught: an error thrown outside React, or a promise rejected with no handler.
export function watchErrors(target: Pick<Window, "addEventListener">) {
  target.addEventListener("error", (e) => reportError("error", e.error ?? e.message));
  target.addEventListener("unhandledrejection", (e) => reportError("rejection", e.reason));
}
