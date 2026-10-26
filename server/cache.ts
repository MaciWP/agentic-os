import { context, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { traced, traceId } from "./telemetry/span.ts";

// The one cache for a provider's answer (Jira, GitHub, gh's account, the env provider).
// - A read joins a load already in flight, so a page and the server's own check share one call;
//   `fresh` skips the kept value but still joins that load.
// - Only a success is kept, for `ttlMs` from when its load started, and only when `keep` says
//   so; a failure drops the kept value, so the read after an error shows the error.
// - `invalidate()` drops the kept value and any load started before it: such a load answers
//   its own callers but never fills the cache.
// - With `onChange`, a kept value past its TTL is answered at once and loaded again behind it;
//   `onChange` runs when that load brings a different value or fails (the value is dropped
//   then, so the next read shows the error).
// - `initial` is a value kept from before (a copy on disk), with the time it was loaded: it
//   counts as kept, so a server that just started answers it like any other.
export type Cached<T> = {
  get: (opts?: { fresh?: boolean }) => Promise<T>;
  invalidate: () => void;
};

export function cached<T>(
  load: () => Promise<T>,
  opts: {
    ttlMs?: number;
    keep?: (value: T) => boolean;
    now?: () => number;
    onChange?: () => void;
    initial?: { at: number; value: T };
  } = {},
): Cached<T> {
  const { ttlMs = Number.POSITIVE_INFINITY, keep = () => true, now = Date.now, onChange } = opts;
  let generation = 0;
  let kept: { at: number; value: T } | undefined = opts.initial;
  // `trace`: who started the load, for the span of whoever joins it.
  let inflight: { generation: number; promise: Promise<T>; trace: string } | undefined;

  const get = ({ fresh = false }: { fresh?: boolean } = {}): Promise<T> => {
    if (!fresh && kept && onChange && now() - kept.at >= ttlMs) {
      const shown = JSON.stringify(kept.value);
      if (inflight?.generation !== generation) {
        // A trace of its own: the request that set it going has answered already.
        const from = traceId();
        context
          .with(ROOT_CONTEXT, () =>
            traced("cache refresh", "refresh", { "from.trace": from }, start),
          )
          .then((value) => JSON.stringify(value) !== shown && onChange(), onChange);
      }
      return Promise.resolve(kept.value);
    }
    if (inflight?.generation === generation) {
      // A span for the wait, pointing at the trace that does the work: without it the time
      // shows as the joining request's own, with nothing under it.
      const { promise, trace: by } = inflight;
      if (!trace.getActiveSpan()?.isRecording()) return promise;
      return traced("cache wait", "wait", { "joined.trace": by }, () => promise);
    }
    if (!fresh && kept && now() - kept.at < ttlMs) return Promise.resolve(kept.value);
    return start();
  };
  const start = (): Promise<T> => {
    const at = now();
    const entry = { generation, promise: load(), trace: traceId() };
    // Settled in the same step that returns the result, so no read after it joins.
    const settle = () => {
      if (inflight === entry) inflight = undefined;
      return entry.generation === generation;
    };
    entry.promise = entry.promise.then(
      (value) => {
        if (settle()) kept = keep(value) ? { at, value } : undefined;
        return value;
      },
      (err) => {
        if (settle()) kept = undefined;
        throw err;
      },
    );
    inflight = entry;
    return entry.promise;
  };
  const invalidate = () => {
    generation++;
    kept = undefined;
  };
  return { get, invalidate };
}

// One `cached` per key (a day of a calendar), made on first use. At most `max` keys are kept;
// past that the family starts over, so a client paging through days cannot grow it unbounded.
export function cachedBy<T>(opts: { ttlMs?: number; max?: number; now?: () => number } = {}) {
  const { max = 32, ...each } = opts;
  const byKey = new Map<string, Cached<T>>();
  return {
    of(key: string, load: () => Promise<T>): Cached<T> {
      let entry = byKey.get(key);
      if (!entry) {
        if (byKey.size >= max) byKey.clear();
        entry = cached(load, each);
        byKey.set(key, entry);
      }
      return entry;
    },
    invalidate: () => byKey.clear(),
  };
}
