import type { Topic } from "../../../shared/events.ts";
import { errorMessage } from "../../error-message.ts";
import { log } from "../../log.ts";
import { Listeners } from "../terminals/contract.ts";

// A list the server checks for changes itself, because nothing tells it. The first load
// (`baseline`) may come from a cache: it should match what the page has just read.
export type Watcher = {
  topic: Topic;
  everyMs: number;
  load: (opts: { baseline: boolean }) => Promise<unknown>;
};

export const COALESCE_MS = 50;

// Fans changes out to the open dashboards. Watchers run only while one is subscribed.
export class EventBus {
  private readonly subscribers = new Listeners<[Topic]>();
  private readonly pending = new Set<Topic>();
  private disposed = false;
  private flushTimer?: Timer;
  private stopWatchers?: () => void;

  constructor(
    private readonly watchers: Watcher[] = [],
    private readonly coalesceMs = COALESCE_MS,
  ) {}

  // A burst (an exit then a remove, a create then its attach) goes out as one event.
  publish(topic: Topic): void {
    if (this.disposed) return;
    this.pending.add(topic);
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = undefined;
      const topics = [...this.pending];
      this.pending.clear();
      for (const t of topics) this.subscribers.notify(t);
    }, this.coalesceMs);
  }

  // How many dashboards hold the stream now: whether a publish reaches anyone.
  get listening(): number {
    return this.subscribers.size;
  }

  subscribe(listener: (topic: Topic) => void): () => void {
    if (this.disposed) throw new Error("event bus disposed");
    const remove = this.subscribers.add(listener);
    if (this.subscribers.size === 1) this.stopWatchers = startWatchers(this.watchers, this);
    return () => {
      remove();
      if (this.subscribers.size > 0) return;
      this.stopWatchers?.();
      this.stopWatchers = undefined;
    };
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.pending.clear();
    this.stopWatchers?.();
    this.stopWatchers = undefined;
  }
}

// Each watcher loads now (the baseline) and then on its interval, and publishes only when
// the result differs from the last one. A failure counts as a result: the panel hears of
// it once, and the log gets it once, not on every tick.
function startWatchers(watchers: Watcher[], bus: EventBus): () => void {
  let stopped = false;
  const timers = watchers.map((w) => {
    let last: string | undefined;
    let busy = false;
    const tick = async () => {
      if (busy || stopped) return;
      busy = true;
      let now: string;
      try {
        now = `ok:${JSON.stringify(await w.load({ baseline: last === undefined }))}`;
      } catch (err) {
        now = `error:${(err as Error).name}:${errorMessage(err)}`;
        if (now !== last) log("events").error(`${w.topic} check failed: ${errorMessage(err)}`);
      }
      busy = false;
      if (!stopped && last !== undefined && now !== last) bus.publish(w.topic);
      last = now;
    };
    void tick();
    return setInterval(tick, w.everyMs);
  });
  return () => {
    stopped = true;
    for (const t of timers) clearInterval(t);
  };
}
