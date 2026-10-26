import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { envFor } from "../../../shared/harness-capabilities.ts";
import {
  CLAUDE_WHEEL_LINES,
  dropBrokenMouseReports,
  GESTURE_CHANGE,
  placeTouchGestures,
} from "./touch.ts";

test("a wheel report with no position is dropped; typed text and valid reports go through", () => {
  const broken = "\x1b[<65;NaN;NaNM";
  expect(dropBrokenMouseReports(broken.repeat(6))).toBe("");
  expect(dropBrokenMouseReports(`a${broken}b`)).toBe("ab");
  expect(dropBrokenMouseReports("\x1b[<64;12;3M")).toBe("\x1b[<64;12;3M");
  expect(dropBrokenMouseReports("NaN is not a number")).toBe("NaN is not a number");
});

test("a gesture step with no position gets the last touch's; one with a position keeps it", () => {
  const el = new EventTarget() as HTMLElement;
  const stop = placeTouchGestures(el);
  const step = () => new Event(GESTURE_CHANGE) as Event & { clientX?: number; clientY?: number };
  const before = step();
  el.dispatchEvent(before);
  expect(before.clientX).toBeUndefined();
  el.dispatchEvent(
    Object.assign(new Event("touchmove"), { touches: [{ clientX: 40, clientY: 90 }] }),
  );
  const glide = step();
  el.dispatchEvent(glide);
  expect([glide.clientX, glide.clientY]).toEqual([40, 90]);
  const placed = Object.assign(step(), { clientX: 1, clientY: 2 });
  el.dispatchEvent(placed);
  expect([placed.clientX, placed.clientY]).toEqual([1, 2]);
  stop();
  const after = step();
  el.dispatchEvent(after);
  expect(after.clientX).toBeUndefined();
});

test("a program that moves several lines per wheel report gets the finger's travel divided", () => {
  const el = new EventTarget() as HTMLElement;
  let lines = CLAUDE_WHEEL_LINES;
  const stop = placeTouchGestures(el, () => lines);
  const step = (translationY: number) =>
    Object.assign(new Event(GESTURE_CHANGE), { translationY }) as Event & { translationY: number };
  const claude = step(-120);
  el.dispatchEvent(claude);
  expect(claude.translationY).toBe(-20);
  lines = 1;
  const shell = step(-120);
  el.dispatchEvent(shell);
  expect(shell.translationY).toBe(-120);
  stop();
});

test("Claude's wheel speed here is the one its terminals are launched with", () => {
  expect(envFor("claude").CLAUDE_CODE_SCROLL_SPEED).toBe(String(CLAUDE_WHEEL_LINES));
});

test("the pinned xterm still names its gesture step so, and its glide still has no position", () => {
  const bundle = readFileSync(
    new URL("../../../node_modules/@xterm/xterm/lib/xterm.mjs", import.meta.url),
    "utf8",
  );
  expect(bundle).toContain(`"${GESTURE_CHANGE}"`);
  // Once the glide carries clientX, placeTouchGestures can go.
  expect(bundle).toMatch(/_newGestureEvent\([\w$]+\.CHANGE\);[\w$]+\.translationX=/);
});
