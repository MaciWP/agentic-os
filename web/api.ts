import type { QueryClient } from "@tanstack/react-query";
import { hc } from "hono/client";
import type { AppType } from "../server/app.ts";
import { machineUrl } from "./machine.ts";

// Every call goes to the tab's machine (web/machine.ts).
export const api = hc<AppType>("/", {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(machineUrl(String(input)), init),
});

// Provider errors must surface as errors, never as empty data.
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
    // For provider_error: which upstream failed, so the UI never blames the wrong one.
    readonly provider: string | null = null,
    // For a refusal (409): why the server would not do it, to offer the way out it allows.
    readonly reason: string | null = null,
    // The server's x-request-id: the key of this call's line in data/server.log.
    readonly requestId: string | null = null,
  ) {
    super(`${status} ${code}${detail ? `: ${detail}` : ""}`);
  }
}

// What to show for a failed call: the server's words when it gave some.
export const errorDetail = (err: Error) => (err instanceof ApiError ? err.detail : err.message);

type JsonResponse = {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
};
// The body type of the non-error branches of a Hono RPC response union.
type OkBody<R> = R extends { ok: false }
  ? never
  : R extends { json(): Promise<infer T> }
    ? T
    : never;

export async function unwrap<R extends JsonResponse>(res: R): Promise<OkBody<R>> {
  if (!res.ok) {
    const body = await res.text();
    let code = "http_error";
    let detail = body.slice(0, 300);
    let provider: string | null = null;
    let reason: string | null = null;
    try {
      const parsed = JSON.parse(body) as {
        error?: unknown;
        detail?: unknown;
        provider?: unknown;
        reason?: unknown;
      };
      if (typeof parsed.error === "string") code = parsed.error;
      if (typeof parsed.provider === "string") provider = parsed.provider;
      if (typeof parsed.reason === "string") reason = parsed.reason;
      if (parsed.detail !== undefined)
        detail = typeof parsed.detail === "string" ? parsed.detail : JSON.stringify(parsed.detail);
    } catch {}
    const requestId = res.headers?.get("x-request-id") ?? null;
    throw new ApiError(res.status, code, detail, provider, reason, requestId);
  }
  return (await res.json()) as OkBody<R>;
}

// The local guard wants JSON on every mutation, bodiless ones included.
export async function mutate<T>(
  path: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body: unknown = {},
): Promise<T> {
  const res = await fetch(machineUrl(path), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await unwrap(res)) as T;
}

// A list the server keeps for a while. Only an explicit refresh asks it for a fresh copy, by
// marking the next read; a push or a reconnect reads the kept one.
// `key` may be a path under another list's key, so that list's push reads it again too.
export function serverCachedQuery<T>(
  key: string | readonly string[],
  read: (query: { fresh?: "1" }) => Promise<T>,
) {
  const queryKey = typeof key === "string" ? [key] : [...key];
  let nextFresh = false;
  return {
    query: {
      queryKey,
      queryFn: () => {
        const fresh = nextFresh;
        nextFresh = false;
        return read(fresh ? { fresh: "1" } : {});
      },
      // Read again when the server says the list changed (web/events.ts), never polled.
      staleTime: Number.POSITIVE_INFINITY,
    },
    // A failure lands in the query's error state; refetchQueries does not throw it.
    refresh: (client: QueryClient) => {
      nextFresh = true;
      return client.refetchQueries({ queryKey }, { cancelRefetch: true });
    },
  };
}
