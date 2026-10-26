import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { TOPICS, type Topic } from "../shared/events.ts";
import { machineUrl } from "./machine.ts";

// 0.5 s, doubling, at most 5 s.
export const retryDelay = (n: number) => Math.min(500 * 2 ** n, 5000);

const isTopic = (data: unknown): data is Topic => TOPICS.includes(data as Topic);

// A stream down this long is said on screen; a server restart or a network blip is shorter.
export const DOWN_MS = 3000;
type Timer = (fn: () => void, ms: number) => () => void;
const browserTimer: Timer = (fn, ms) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

// Whether the stream is down: an error with no open for DOWN_MS, until the next open.
export class StreamHealth {
  private cancel: (() => void) | null = null;
  constructor(
    private readonly set: (down: boolean) => void,
    private readonly timer: Timer = browserTimer,
  ) {}
  opened(): void {
    this.dispose();
    this.set(false);
  }
  failed(): void {
    this.cancel ??= this.timer(() => {
      this.cancel = null;
      this.set(true);
    }, DOWN_MS);
  }
  dispose(): void {
    this.cancel?.();
    this.cancel = null;
  }
}

// The dashboard's lists are not polled: the server says which one changed, and only that
// query is read again. Mounted once, in the dashboard shell; terminal windows hold no
// stream, because a browser shares six connections per host across all its tabs.
// True while the stream is down: nothing on screen updates then, and the shell says so.
export function useServerEvents(): boolean {
  const client = useQueryClient();
  const [down, setDown] = useState(false);
  useEffect(() => {
    const health = new StreamHealth(setDown);
    let source: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const refresh = (topic: Topic) => void client.invalidateQueries({ queryKey: [topic] });
    const connect = () => {
      source = new EventSource(machineUrl("/api/events"));
      // Every open reads each list again: a reconnect may have missed events, and on the
      // first open the server's baseline may already be newer than what the page loaded.
      // The server shares one load per list, so this costs no extra Jira search.
      source.onopen = () => {
        health.opened();
        for (const t of TOPICS) refresh(t);
        tries = 0;
      };
      source.onmessage = (event) => {
        if (isTopic(event.data)) refresh(event.data);
      };
      // A network error reconnects by itself. A non-200 answer (the dev proxy while the
      // server restarts) closes the stream for good, so it is opened again here.
      source.onerror = () => {
        health.failed();
        if (source?.readyState !== EventSource.CLOSED) return;
        source.close();
        timer = setTimeout(connect, retryDelay(tries++));
      };
    };
    connect();
    return () => {
      health.dispose();
      clearTimeout(timer);
      source?.close();
    };
  }, [client]);
  return down;
}
