import { expect, test } from "bun:test";
import type { KeyEventLike } from "../voice/hotkey.ts";
import { clipboardKey, OSC52_MAX, osc52Text } from "./clipboard-keys.ts";

const key = (k: string, over: Partial<KeyEventLike> = {}): KeyEventLike => ({
  type: "keydown",
  key: k,
  ctrlKey: true,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  repeat: false,
  ...over,
});
const pc = { mac: false, selected: false };

test("on Windows Ctrl+C copies a selection and is still ^C without one", () => {
  expect(clipboardKey(key("c"), { ...pc, selected: true })).toBe("copy");
  expect(clipboardKey(key("C"), { ...pc, selected: true })).toBe("copy");
  expect(clipboardKey(key("c"), pc)).toBeNull();
});

test("on Windows Ctrl+V is the browser's paste, selection or not", () => {
  expect(clipboardKey(key("v"), pc)).toBe("paste");
  expect(clipboardKey(key("v"), { ...pc, selected: true })).toBe("paste");
});

test("other chords stay the program's, and so does everything on a Mac", () => {
  // Ctrl+Shift+V opens the image history; AltGr arrives as Ctrl+Alt.
  expect(clipboardKey(key("v", { shiftKey: true }), pc)).toBeNull();
  expect(clipboardKey(key("v", { altKey: true }), pc)).toBeNull();
  expect(clipboardKey(key("c", { ctrlKey: false }), { ...pc, selected: true })).toBeNull();
  expect(clipboardKey(key("x"), pc)).toBeNull();
  expect(clipboardKey(key("c"), { mac: true, selected: true })).toBeNull();
  expect(clipboardKey(key("v"), { mac: true, selected: false })).toBeNull();
});

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

test("an OSC 52 write gives its text, accents and emoji included, whatever the targets", () => {
  expect(osc52Text(`c;${b64("copiado ñ 🟢")}`)).toBe("copiado ñ 🟢");
  expect(osc52Text(`;${b64("sin destino")}`)).toBe("sin destino");
  expect(osc52Text("c;")).toBe("");
});

test("an OSC 52 read, a broken payload or an oversized one writes nothing", () => {
  expect(osc52Text("c;?")).toBeNull();
  expect(osc52Text(b64("sin punto y coma"))).toBeNull();
  expect(osc52Text("c;no-es-base64!")).toBeNull();
  // Not UTF-8: decoded with `fatal`, never written as replacement characters.
  expect(osc52Text("c;/w==")).toBeNull();
  expect(osc52Text(`c;${b64("x".repeat(OSC52_MAX + 3))}`)).toBeNull();
});
