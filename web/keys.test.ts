import { describe, expect, test } from "bun:test";
import { captureShortcut, isCaptureKey, shortcut } from "./keys.ts";

describe("shortcut", () => {
  test("names the key this keyboard has: ⌘ on a Mac, Ctrl elsewhere", () => {
    expect(shortcut("K", { mac: true })).toBe("⌘K");
    expect(shortcut("K", { mac: false })).toBe("Ctrl+K");
    expect(shortcut("V", { mac: true, shift: true })).toBe("⌘⇧V");
    expect(shortcut("V", { mac: false, shift: true })).toBe("Ctrl+Shift+V");
  });
});

describe("isCaptureKey", () => {
  const key = (
    code: string,
    mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean },
  ) => ({
    code,
    ctrlKey: Boolean(mods.ctrl),
    metaKey: Boolean(mods.meta),
    shiftKey: Boolean(mods.shift),
    altKey: Boolean(mods.alt),
  });

  test("⌃⌘4 on a Mac, Ctrl+Shift+4 elsewhere, told by the key's place", () => {
    expect(isCaptureKey(key("Digit4", { ctrl: true, meta: true }), true)).toBe(true);
    expect(isCaptureKey(key("Digit4", { ctrl: true, shift: true }), false)).toBe(true);
    expect([captureShortcut(true), captureShortcut(false)]).toEqual(["⌃⌘4", "Ctrl+Shift+4"]);
  });

  test("the system's own captures, AltGr and the other digits are not it", () => {
    // ⌘⇧4 is macOS's own; Ctrl+Alt is AltGr on a Spanish keyboard (AltGr+4 types ~).
    expect(isCaptureKey(key("Digit4", { meta: true, shift: true }), true)).toBe(false);
    expect(isCaptureKey(key("Digit4", { ctrl: true, meta: true, shift: true }), true)).toBe(false);
    expect(isCaptureKey(key("Digit4", { ctrl: true, alt: true }), false)).toBe(false);
    expect(isCaptureKey(key("Digit4", { ctrl: true, shift: true }), true)).toBe(false);
    expect(isCaptureKey(key("Digit4", { ctrl: true, meta: true }), false)).toBe(false);
    expect(isCaptureKey(key("Digit3", { ctrl: true, meta: true }), true)).toBe(false);
    expect(isCaptureKey(key("Numpad4", { ctrl: true, shift: true }), false)).toBe(false);
  });
});
