import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { EventBus } from "../events/bus.ts";
import { FileError } from "../files/browse.ts";
import { REVEAL_TTL_MS, revealRoutes } from "./reveal.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "aos-reveal-")));
mkdirSync(join(root, "src"));
writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
afterAll(() => rmSync(root, { recursive: true, force: true }));

function make() {
  const bus = new EventBus([], 0);
  const heard: string[] = [];
  let clock = 1_000;
  const where = async (location: string) => {
    if (location !== "repo:r") throw new Error(`unknown location ${location}`);
    return { bin: null, cwd: root, env: {} };
  };
  const app = new Hono()
    .route(
      "/reveal",
      revealRoutes(bus, where, () => clock),
    )
    .onError((err, c) =>
      err instanceof FileError
        ? c.json({ error: err.code }, err.status as 400)
        : c.json({ error: err.message }, 500),
    );
  const post = async (body: unknown) => {
    const r = await app.request("/reveal", { method: "POST", body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
  const get = async () =>
    (await (await app.request("/reveal")).json()) as Record<string, unknown> | null;
  return { bus, heard, post, get, tick: (ms: number) => (clock += ms) };
}

test("an ask is kept, announced, and read back without being used up", async () => {
  const m = make();
  const off = m.bus.subscribe((t) => m.heard.push(t));
  const sent = await m.post({ location: "repo:r", path: "src/a.ts", line: 3 });
  expect(sent.status).toBe(200);
  expect(sent.json.delivered).toBe(true);
  await Bun.sleep(5);
  expect(m.heard).toEqual(["reveal"]);
  const first = await m.get();
  expect(first).toEqual({ id: sent.json.id, location: "repo:r", path: "src/a.ts", line: 3 });
  // A refetch or a second tab reads the same ask.
  expect(await m.get()).toEqual(first);
  off();
});

test("with no dashboard open it says so, and the ask waits for one only a while", async () => {
  const m = make();
  const sent = await m.post({ location: "repo:r", path: "src/a.ts" });
  expect(sent.json.delivered).toBe(false);
  expect((await m.get())?.line).toBeNull();
  m.tick(REVEAL_TTL_MS);
  expect(await m.get()).toBeNull();
});

test("each ask has its own id, and the last one wins", async () => {
  const m = make();
  const a = await m.post({ location: "repo:r", path: "src/a.ts", line: 1 });
  const b = await m.post({ location: "repo:r", path: "src/a.ts", line: 2 });
  expect(a.json.id).not.toBe(b.json.id);
  expect((await m.get())?.line).toBe(2);
});

test("a bad body, an unknown place, a folder or a path out of the place is refused and kept out", async () => {
  const m = make();
  expect((await m.post({ location: "repo:r", path: "src/a.ts", line: 0 })).status).toBe(400);
  expect((await m.post({ location: "repo:r" })).status).toBe(400);
  expect((await m.post({ location: "repo:x", path: "src/a.ts" })).status).toBe(500);
  expect((await m.post({ location: "repo:r", path: "src" })).json.error).toBe("not_a_file");
  expect(
    (await m.post({ location: "repo:r", path: "../etc/passwd" })).status,
  ).toBeGreaterThanOrEqual(400);
  expect(
    (await m.post({ location: "repo:r", path: "src/missing.ts" })).status,
  ).toBeGreaterThanOrEqual(400);
  expect(await m.get()).toBeNull();
});
