import { expect, test } from "bun:test";
import { Lifecycle } from "./lifecycle.ts";

test("construction is inert, start is once, cleanup is reverse and idempotent", () => {
  const seen: string[] = [];
  const life = new Lifecycle();
  life.add(() => {
    seen.push("first");
    return () => {
      seen.push("off-first");
    };
  });
  life.add(() => {
    seen.push("second");
    return () => {
      seen.push("off-second");
    };
  });
  expect(seen).toEqual([]);
  life.start();
  life.start();
  life.dispose();
  life.dispose();
  expect(seen).toEqual(["first", "second", "off-second", "off-first"]);
});

test("a failed start cleans up already started resources", () => {
  let active = false;
  const life = new Lifecycle();
  life.add(() => {
    active = true;
    return () => {
      active = false;
    };
  });
  life.add(() => {
    throw new Error("cannot start");
  });
  expect(() => life.start()).toThrow("cannot start");
  expect(active).toBe(false);
});
