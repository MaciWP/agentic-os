import { expect, test } from "bun:test";
import { tooShort } from "./use-dictation.ts";

test("a too-short take says what to do with the keys this keyboard has", () => {
  expect(tooShort(true)).toContain("mantén ⌃⌘ mientras hablas");
  // Off the Mac dictation runs from the button: ⌃⌘ is no key there.
  expect(tooShort(false)).not.toContain("⌘");
  expect(tooShort(false)).toContain("habla un poco más antes de parar");
});
