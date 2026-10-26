import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { storageFamily, storageKey } from "./storage.ts";
import { memoryStorage } from "./test-storage.ts";

let restore: (() => void)[] = [];
const disk = (area: "local" | "session", entries?: Record<string, string> | null) => {
  const m = memoryStorage(area, entries);
  restore.push(m.restore);
  return m.data;
};
afterEach(() => {
  for (const r of restore.reverse()) r();
  restore = [];
});

const mode = storageKey("aos.test.mode", {
  schema: z.enum(["unified", "split"]),
  fallback: "unified",
});

describe("storageKey", () => {
  test("keeps a text value as the plain string, readable by what wrote it before", () => {
    const data = disk("local", { "aos.test.mode": "split" });
    expect(mode.get()).toBe("split");
    expect(mode.set("unified")).toBe(true);
    expect(data.get("aos.test.mode")).toBe("unified");
    expect(mode.remove()).toBe(true);
    expect(data.has("aos.test.mode")).toBe(false);
  });

  test("a value the schema refuses, bad JSON or no storage at all give the default", () => {
    disk("local", { "aos.test.mode": "sideways", "aos.test.open": "{not json" });
    expect(mode.get()).toBe("unified");
    const open = storageKey("aos.test.open", {
      schema: z.record(z.string(), z.boolean()),
      fallback: {},
      codec: "json",
    });
    expect(open.get()).toEqual({});
    disk("local", null);
    expect(mode.get()).toBe("unified");
    expect(mode.set("split")).toBe(false);
  });

  test("a storage that throws on every call never throws out; the write says it failed", () => {
    const fail = () => {
      throw new Error("QuotaExceededError");
    };
    const { restore: undo } = memoryStorage("local");
    restore.push(undo);
    const original = globalThis.localStorage;
    undo();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: fail,
    });
    try {
      expect(mode.get()).toBe("unified");
      expect(mode.set("split")).toBe(false);
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: original,
        writable: true,
      });
    }
  });

  test("json keys round-trip through the schema", () => {
    const data = disk("local");
    const open = storageKey("aos.test.json", {
      schema: z.record(z.string(), z.boolean()),
      fallback: {},
      codec: "json",
    });
    expect(open.set({ a: true })).toBe(true);
    expect(data.get("aos.test.json")).toBe('{"a":true}');
    expect(open.get()).toEqual({ a: true });
  });

  test("session keys live in sessionStorage, apart from local ones", () => {
    const local = disk("local");
    const session = disk("session");
    const active = storageKey("aos.test.active", {
      schema: z.string(),
      fallback: "",
      area: "session",
    });
    active.set("m1");
    expect(session.get("aos.test.active")).toBe("m1");
    expect(local.size).toBe(0);
  });

  test("an old unprefixed key moves once to its new name and the setting is kept", () => {
    const data = disk("local", { "font-size": "15" });
    const font = storageKey("aos.test.font", {
      schema: z.coerce.number().int().min(8).max(32),
      fallback: 13,
      legacy: "font-size",
    });
    expect(font.get()).toBe(15);
    expect(data.get("aos.test.font")).toBe("15");
    expect(data.has("font-size")).toBe(false);
  });

  test("when both names exist the new one wins, and a write drops the old one", () => {
    const data = disk("local", { "font-size": "15", "aos.test.font2": "18" });
    const font = storageKey("aos.test.font2", {
      schema: z.coerce.number(),
      fallback: 13,
      legacy: "font-size",
    });
    expect(font.get()).toBe(18);
    expect(data.get("font-size")).toBe("15");
    font.set(20);
    expect(data.has("font-size")).toBe(false);
  });
});

describe("storageKey watch", () => {
  test("another tab's write of the key reaches the watcher, decoded; other keys do not", () => {
    disk("local");
    // No DOM under bun test: a bare EventTarget stands in for the window.
    const win = new EventTarget();
    Object.assign(globalThis, { window: win });
    restore.push(() => Reflect.deleteProperty(globalThis, "window"));
    const write = (key: string, newValue: string) =>
      win.dispatchEvent(Object.assign(new Event("storage"), { key, newValue }));
    const seen: string[] = [];
    const stop = mode.watch((v) => seen.push(v));
    write("aos.test.mode", "split");
    write("aos.test.other", "x");
    write("aos.test.mode", "bad");
    stop();
    write("aos.test.mode", "split");
    expect(seen).toEqual(["split", "unified"]);
  });
});

describe("storageFamily", () => {
  test("keys by id under one prefix, lists the ids kept and migrates per id", () => {
    const data = disk("session", { "aos.test.launch:a": "r1", "other:b": "x", "w:c": "300" });
    const launch = storageFamily("aos.test.launch:", {
      schema: z.string().nullable(),
      fallback: null,
      area: "session",
    });
    expect(launch.get("a")).toBe("r1");
    expect(launch.get("zz")).toBeNull();
    launch.set("b", "r2");
    expect(launch.ids().sort()).toEqual(["a", "b"]);
    launch.remove("a");
    expect(launch.ids()).toEqual(["b"]);

    const width = storageFamily("aos.test.width:", {
      schema: z.coerce.number().positive().nullable(),
      fallback: null,
      area: "session",
      legacy: (id) => `w:${id}`,
    });
    expect(width.get("c")).toBe(300);
    expect(data.has("w:c")).toBe(false);
  });
});

describe("a worker's tab", () => {
  test("keeps its own copy of every key, apart from the hub's and the machine choice", () => {
    const local = disk("local", { "aos.test.mode": "split" });
    disk("session", { "aos.machine": "win" });
    expect(mode.get()).toBe("unified");
    expect(mode.set("split")).toBe(true);
    expect(local.get("aos.@win.test.mode")).toBe("split");
    const notes = storageFamily("aos.test.note:", { schema: z.string(), fallback: "" });
    notes.set("a", "x");
    expect(local.get("aos.@win.test.note:a")).toBe("x");
    expect(notes.ids()).toEqual(["a"]);
    expect(
      storageKey("aos.machine", { schema: z.string(), fallback: "", area: "session" }).get(),
    ).toBe("win");
  });
});
