import { describe, expect, test } from "bun:test";
import { cached, cachedBy } from "./cache.ts";

// A load the test settles by hand, counting how often it was started.
function loads<T>() {
  const pending: { resolve: (v: T) => void; reject: (e: Error) => void }[] = [];
  const load = () => new Promise<T>((resolve, reject) => pending.push({ resolve, reject }));
  return { load, pending };
}

describe("cached", () => {
  test("a read joins the load in flight, then gets the kept value until the TTL", async () => {
    let clock = 0;
    const l = loads<string>();
    const c = cached(l.load, { ttlMs: 100, now: () => clock });
    const a = c.get();
    expect(c.get()).toBe(a);
    l.pending[0]?.resolve("one");
    expect(await a).toBe("one");
    clock = 99;
    expect(await c.get()).toBe("one");
    expect(l.pending).toHaveLength(1);
    clock = 100;
    const b = c.get();
    expect(l.pending).toHaveLength(2);
    l.pending[1]?.resolve("two");
    expect(await b).toBe("two");
  });

  test("fresh skips the kept value but joins the load in flight", async () => {
    const l = loads<string>();
    const c = cached(l.load);
    const first = c.get();
    l.pending[0]?.resolve("one");
    await first;
    const fresh = c.get({ fresh: true });
    expect(l.pending).toHaveLength(2);
    expect(c.get({ fresh: true })).toBe(fresh);
    l.pending[1]?.resolve("two");
    expect(await fresh).toBe("two");
  });

  test("a failure drops the kept value", async () => {
    const l = loads<string>();
    const c = cached(l.load);
    const ok = c.get();
    l.pending[0]?.resolve("one");
    await ok;
    const failed = c.get({ fresh: true });
    l.pending[1]?.reject(new Error("down"));
    await expect(failed).rejects.toThrow("down");
    const next = c.get();
    expect(l.pending).toHaveLength(3);
    l.pending[2]?.resolve("back");
    expect(await next).toBe("back");
  });

  test("with onChange, a stale value is answered at once and loaded again behind it", async () => {
    let clock = 0;
    let changes = 0;
    const l = loads<string>();
    const c = cached(l.load, { ttlMs: 100, now: () => clock, onChange: () => changes++ });
    const first = c.get();
    l.pending[0]?.resolve("one");
    await first;
    clock = 100;
    expect(await c.get()).toBe("one");
    expect(await c.get()).toBe("one");
    expect(l.pending).toHaveLength(2);
    l.pending[1]?.resolve("one");
    await Bun.sleep(0);
    expect(changes).toBe(0);
    clock = 200;
    expect(await c.get()).toBe("one");
    l.pending[2]?.resolve("two");
    await Bun.sleep(0);
    expect(changes).toBe(1);
    expect(await c.get()).toBe("two");
    clock = 300;
    expect(await c.get()).toBe("two");
    l.pending[3]?.reject(new Error("down"));
    await Bun.sleep(0);
    expect(changes).toBe(2);
    // The failure dropped the value: the next read waits for a load of its own.
    const next = c.get();
    expect(l.pending).toHaveLength(5);
    l.pending[4]?.reject(new Error("still down"));
    await expect(next).rejects.toThrow("still down");
  });

  test("an initial value is answered at once; past its TTL it is loaded again behind it", async () => {
    const clock = 1_000;
    let changes = 0;
    const l = loads<string>();
    const fresh = cached(l.load, {
      ttlMs: 100,
      now: () => clock,
      initial: { at: 950, value: "disk" },
    });
    expect(await fresh.get()).toBe("disk");
    expect(l.pending).toHaveLength(0);
    const stale = cached(l.load, {
      ttlMs: 100,
      now: () => clock,
      onChange: () => changes++,
      initial: { at: 0, value: "disk" },
    });
    expect(await stale.get()).toBe("disk");
    expect(l.pending).toHaveLength(1);
    l.pending[0]?.resolve("live");
    await Bun.sleep(0);
    expect(changes).toBe(1);
    expect(await stale.get()).toBe("live");
  });

  test("a value `keep` refuses is returned but not kept", async () => {
    const l = loads<{ partial: boolean }>();
    const c = cached(l.load, { keep: (v) => !v.partial });
    const a = c.get();
    l.pending[0]?.resolve({ partial: true });
    expect(await a).toEqual({ partial: true });
    void c.get();
    expect(l.pending).toHaveLength(2);
  });

  test("invalidate: a load started before it answers its callers but never fills the cache", async () => {
    const l = loads<string>();
    const c = cached(l.load);
    const old = c.get();
    c.invalidate();
    const next = c.get();
    expect(next).not.toBe(old);
    l.pending[0]?.resolve("old");
    expect(await old).toBe("old");
    l.pending[1]?.resolve("new");
    expect(await next).toBe("new");
    expect(await c.get()).toBe("new");
    expect(l.pending).toHaveLength(2);
  });
});

test("a keyed family reads each key once per ttl and starts over past its size", async () => {
  let at = 0;
  const loads: string[] = [];
  const days = cachedBy<string>({ ttlMs: 1000, max: 2, now: () => at });
  const read = (day: string) =>
    days
      .of(day, async () => {
        loads.push(day);
        return day;
      })
      .get();
  await read("a");
  await read("a");
  await read("b");
  expect(loads).toEqual(["a", "b"]);
  at = 1500;
  await read("a");
  // A third key empties the family, so "b" is read again.
  await read("c");
  await read("b");
  expect(loads).toEqual(["a", "b", "a", "c", "b"]);
  days.invalidate();
  await read("b");
  expect(loads).toHaveLength(6);
});
