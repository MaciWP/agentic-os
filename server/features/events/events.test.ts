import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Topic } from "../../../shared/events.ts";
import { createApp } from "../../app.ts";
import { ConfigSchema } from "../../config.ts";
import { openDb } from "../../db.ts";
import { githubClient } from "../github/prs.ts";
import { cleanEnv } from "../terminals/env.ts";
import { TerminalManager } from "../terminals/pty.ts";
import { AttachTokens } from "../terminals/ws-guard.ts";
import { EventBus } from "./bus.ts";

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
};
const listen = (bus: EventBus) => {
  const got: Topic[] = [];
  const unsubscribe = bus.subscribe((t) => got.push(t));
  return { got, unsubscribe };
};

describe("event bus", () => {
  test("a burst goes out as one event per topic", async () => {
    const bus = new EventBus([], 10);
    const { got } = listen(bus);
    bus.publish("terminals");
    bus.publish("terminals");
    bus.publish("tickets");
    bus.publish("terminals");
    await Bun.sleep(40);
    expect(got).toEqual(["terminals", "tickets"]);
    bus.publish("tickets");
    await until(() => got.length === 3);
    expect(got[2]).toBe("tickets");
  });

  test("watchers run only while a dashboard listens", async () => {
    let loads = 0;
    const bus = new EventBus([{ topic: "tickets", everyMs: 10, load: async () => loads++ }], 1);
    await Bun.sleep(30);
    expect(loads).toBe(0);
    const a = listen(bus);
    expect(loads).toBe(1); // the baseline, at once
    const b = listen(bus);
    await until(() => loads > 3);
    a.unsubscribe();
    const withOne = loads;
    await until(() => loads > withOne);
    b.unsubscribe();
    await Bun.sleep(15);
    const stopped = loads;
    await Bun.sleep(40);
    expect(loads).toBe(stopped);
  });

  test("a watcher publishes only when its result changes", async () => {
    let value = 1;
    let loads = 0;
    const load = async () => {
      loads++;
      return { value };
    };
    const bus = new EventBus([{ topic: "tickets", everyMs: 5, load }], 1);
    const { got, unsubscribe } = listen(bus);
    await until(() => loads > 5);
    expect(got).toEqual([]);
    value = 2;
    await until(() => got.length === 1);
    const settled = loads;
    await until(() => loads > settled + 5);
    expect(got).toEqual(["tickets"]);
    unsubscribe();
  });

  test("a failing check is logged and published once per change of state", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    let failing = false;
    let loads = 0;
    const load = async () => {
      loads++;
      if (failing) throw new Error("host unreachable");
      return [];
    };
    const bus = new EventBus([{ topic: "tickets", everyMs: 5, load }], 1);
    const { got, unsubscribe } = listen(bus);
    await until(() => loads > 2);
    failing = true;
    await until(() => got.length === 1);
    const failed = loads;
    await until(() => loads > failed + 5);
    expect(got).toEqual(["tickets"]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain("host unreachable");
    failing = false;
    await until(() => got.length === 2);
    unsubscribe();
    error.mockRestore();
  });

  test("a slow check never overlaps itself", async () => {
    let running = 0;
    let most = 0;
    const load = async () => {
      running++;
      most = Math.max(most, running);
      await Bun.sleep(30);
      running--;
    };
    const bus = new EventBus([{ topic: "tickets", everyMs: 5, load }], 1);
    const { unsubscribe } = listen(bus);
    await Bun.sleep(100);
    unsubscribe();
    expect(most).toBe(1);
  });
});

describe("GET /api/events", () => {
  const home = mkdtempSync(join(tmpdir(), "aos-events-"));
  const config = ConfigSchema.parse({ terminals: { shell: "/bin/sh" } });
  const db = openDb(":memory:");
  const env = Promise.resolve(cleanEnv({ PATH: "/usr/bin:/bin" }, {}));
  const manager = new TerminalManager(config, db, () => env);
  // The pull-request watcher stands for every watcher: it counts its loads.
  let scans = 0;
  const github = {
    ...githubClient(config),
    list: async () => {
      scans++;
      return { prs: [], errors: [] };
    },
  };
  const app = createApp({
    config,
    db,
    terminals: manager,
    tokens: new AttachTokens(),
    sessions: { home, procs: async () => new Map() },
    github,
  });
  app.start();
  afterAll(async () => {
    app.dispose();
    await manager.stopAll(200);
    rmSync(home, { recursive: true, force: true });
  });

  const open = async () => {
    const res = await app.request("/api/events", { headers: { host: "127.0.0.1:4317" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let seen = "";
    const read = async (want: string) => {
      const end = Date.now() + 3000;
      while (!seen.includes(want)) {
        if (Date.now() > end)
          throw new Error(`no ${JSON.stringify(want)} in ${JSON.stringify(seen)}`);
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        seen += new TextDecoder().decode(value);
      }
    };
    await read("retry: 1000\n\n");
    return { read, close: () => reader.cancel() };
  };

  test("a terminal change reaches the stream, and closing it unsubscribes", async () => {
    const stream = await open();
    await until(() => scans === 1); // the watchers started with the stream
    const info = await manager.create({ harness: "shell", location: "app" });
    await stream.read("data: terminals\n\n");
    manager.stop(info.id);
    await stream.close();
    await Bun.sleep(50);
    // Only a bus left with no listener starts its watchers again, with a new baseline.
    const next = await open();
    await until(() => scans === 2);
    await next.close();
  });

  test("a cross-site page cannot open the stream", async () => {
    const res = await app.request("/api/events", { headers: { host: "evil.test" } });
    expect(res.status).not.toBe(200);
  });
});
