import { propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Context, MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { isMarked } from "./span.ts";

// One span per request, named by its route pattern (`GET /api/tickets/:key`), child of the
// caller's `traceparent` when there is one. Written here instead of @hono/otel, which stores
// `url.full` with its query (an OAuth `?code=`) and pins a newer API.

// Requests that never end, or that would trace the tracing: kept out before a span opens.
const UNTRACED = [
  /^\/api\/events$/,
  /\/ws$/,
  /^\/api\/machines\/[^/]+\/events$/,
  /^\/api\/(machines\/[^/]+\/)?ai\/v1\//,
  /^\/api\/workboard\/session$/,
  /^\/api\/telemetry\//,
];
export const untraced = (path: string, headers: Headers) =>
  headers.has("upgrade") ||
  (headers.get("accept") ?? "").includes("text/event-stream") ||
  UNTRACED.some((r) => r.test(path));

// The query keys worth a span, each with the shape its value must have; anything else (a code,
// a token, a search) is never stored.
const KEYS: Record<string, RegExp> = {
  fresh: /^1$/,
  day: /^\d{4}-\d{2}-\d{2}$/,
  kind: /^[a-z]{1,16}$/,
  offset: /^-?\d{1,4}$/,
  lines: /^\d{1,5}$/,
  tab: /^[a-z-]{1,24}$/,
};
export function shownQuery(url: URL): string {
  const kept = [...url.searchParams].filter(([k, v]) => KEYS[k]?.test(v));
  return kept.length ? `?${new URLSearchParams(kept)}` : "";
}

const tracer = () => trace.getTracer("agentic-os");

// The breaker's own answer while a machine is known down is not a new failure: the log
// already silences it, and counting it would bury every real error while the PC is off.
const offline = (c: Context) => c.res.status === 503 && c.res.headers.has("retry-after");

export const traceRequests = (): MiddlewareHandler => async (c, next) => {
  if (untraced(c.req.path, c.req.raw.headers)) return next();
  const parent = propagation.extract(ROOT_CONTEXT, Object.fromEntries(c.req.raw.headers));
  const url = new URL(c.req.url);
  return tracer().startActiveSpan(
    `${c.req.method} ${c.req.path}`,
    {
      kind: SpanKind.SERVER,
      attributes: { "http.request.method": c.req.method, "url.query": shownQuery(url) },
    },
    parent,
    async (span) => {
      try {
        await next();
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err).slice(0, 300) });
        throw err;
      } finally {
        const route = routePath(c);
        span.updateName(`${c.req.method} ${route}`);
        span.setAttribute("http.route", route);
        span.setAttribute("http.response.status_code", c.res.status);
        // A 4xx is the caller's mistake, answered as designed: an error only on the server side.
        if (c.res.status >= 500 && !offline(c) && !isMarked(span))
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: (c.error?.message ?? `HTTP ${c.res.status}`).slice(0, 300),
          });
        span.end();
      }
    },
  );
};
