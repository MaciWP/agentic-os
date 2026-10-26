import {
  type Attributes,
  type Context,
  context,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { errorMessage } from "../error-message.ts";

// What the app's code calls: the OpenTelemetry API only, so it costs nothing when telemetry is
// off (the API's no-op tracer) and needs no SDK in tests.

const tracer = () => trace.getTracer("agentic-os");

// An outside call (Jira, git, the PC…) as a span under the current request. `op` names its kind
// for the per-minute timings: jira, google, git, gh, pc, host, ai, cmd.
export function traced<T>(
  name: string,
  op: string,
  attrs: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(
    name,
    { kind: SpanKind.CLIENT, attributes: { "aos.op": op, ...attrs } },
    live(),
    async (span) => {
      try {
        return await fn(span);
      } catch (err) {
        failed(span, err);
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

// The active trace id, for the `x-trace-id` header, the log lines and a
// wait that points at the trace it waited on; "" without a span.
export const traceId = () => {
  const ctx = trace.getSpanContext(context.active());
  return ctx && trace.isSpanContextValid(ctx) ? ctx.traceId : "";
};

// The context to start a span in. A timer or watcher first set going inside a request keeps
// that request's context after it ended: what it does later is a trace of its own.
export function live(): Context {
  const span = trace.getActiveSpan();
  return span && !span.isRecording() ? ROOT_CONTEXT : context.active();
}

export function failed(span: Span, err: unknown): void {
  span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(err).slice(0, 300) });
}

// A failure the code handles (logged, answered 4xx, partly done) still marks its trace, so the
// trace is kept and `aos trace errors` shows it. Its message wins over a generic "HTTP 500".
const marked = new WeakSet<Span>();
export function markError(message: string): void {
  const span = trace.getActiveSpan();
  if (!span?.isRecording()) return;
  span.setStatus({ code: SpanStatusCode.ERROR, message: message.slice(0, 300) });
  marked.add(span);
}
export const isMarked = (span: Span) => marked.has(span);

// A path as a span name: no query, and ids (any segment with a digit, past a short version
// like `3` or `v1`) as `:id`, so one endpoint is one name in the per-minute timings.
export const pathTemplate = (path: string) =>
  (path.split(/[?#]/)[0] ?? "")
    .split("/")
    .map((seg) => (/\d/.test(seg) && !/^v?\d{1,2}(\.\d)?$/.test(seg) ? ":id" : seg))
    .join("/");
