import { describe, expect, test } from "bun:test";
import { type DictationAction, DictationKeys, HOLD_MS, type KeyEventLike } from "./hotkey.ts";

const key = (type: string, k: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
  type,
  key: k,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  repeat: false,
  ...mods,
});
const both = { ctrlKey: true, metaKey: true };

function setup(enabled = true) {
  const actions: DictationAction[] = [];
  const holds: { fn: () => void; ms: number; on: boolean }[] = [];
  let busy = false;
  const keys = new DictationKeys(
    (a) => {
      actions.push(a);
      if (a === "start") busy = true;
      if (a === "cancel") busy = false;
    },
    { enabled: () => enabled, busy: () => busy },
    (fn, ms) => {
      const h = { fn, ms, on: true };
      holds.push(h);
      return () => {
        h.on = false;
      };
    },
  );
  const elapse = () => {
    for (const h of holds.filter((h) => h.on)) {
      h.on = false;
      h.fn();
    }
  };
  // ⌃ then ⌘ pressed, as a hand does.
  const press = () => [
    keys.handle(key("keydown", "Control", { ctrlKey: true })),
    keys.handle(key("keydown", "Meta", both)),
  ];
  return {
    keys,
    actions,
    holds,
    elapse,
    press,
    setBusy: (b: boolean) => {
      busy = b;
    },
  };
}

describe("dictation keys", () => {
  test("⌃⌘ starts recording at once; after the hold, releasing either key stops", () => {
    const { keys, actions, holds, elapse, press } = setup();
    // The modifiers themselves still reach the terminal.
    expect(press()).toEqual([true, true]);
    expect(holds[0]?.ms).toBe(HOLD_MS);
    expect(actions).toEqual(["start"]);
    elapse();
    expect(actions).toEqual(["start"]);
    // Auto-repeat of the held keys changes nothing.
    expect(keys.handle(key("keydown", "Meta", { ...both, repeat: true }))).toBe(false);
    expect(keys.handle(key("keyup", "Meta", { ctrlKey: true }))).toBe(false);
    expect(actions).toEqual(["start", "stop"]);
  });

  test("a ⌃⌘ shortcut is not a dictation: another key before the hold drops it and goes through", () => {
    const { keys, actions, elapse, press } = setup();
    press();
    expect(keys.handle(key("keydown", "k", both))).toBe(true);
    elapse();
    expect(actions).toEqual(["start", "cancel"]);
  });

  test("released before the hold, it was a tap: the recording is dropped", () => {
    const { keys, actions, elapse, press } = setup();
    press();
    expect(keys.handle(key("keyup", "Control", { metaKey: true }))).toBe(true);
    elapse();
    expect(actions).toEqual(["start", "cancel"]);
  });

  test("Esc before the hold drops the recording and never reaches the terminal", () => {
    const { keys, actions, press } = setup();
    press();
    expect(keys.handle(key("keydown", "Escape", both))).toBe(false);
    expect(actions).toEqual(["start", "cancel"]);
  });

  test("⌃ alone, ⌘ alone, or with ⌥ or ⇧, never arms", () => {
    const { keys, holds } = setup();
    keys.handle(key("keydown", "Control", { ctrlKey: true }));
    keys.handle(key("keydown", "Meta", { metaKey: true }));
    keys.handle(key("keydown", "Meta", { ...both, altKey: true }));
    keys.handle(key("keydown", "Meta", { ...both, shiftKey: true }));
    expect(holds).toEqual([]);
  });

  test("a terminal that takes no dictation ignores the hold", () => {
    const { holds, press } = setup(false);
    press();
    expect(holds).toEqual([]);
  });

  test("while recording, Esc cancels and no key reaches the terminal", () => {
    const { keys, actions, elapse, press } = setup();
    press();
    elapse();
    expect(keys.handle(key("keydown", "a", both))).toBe(false);
    expect(keys.handle(key("keypress", "a", both))).toBe(false);
    expect(keys.handle(key("keydown", "Escape", both))).toBe(false);
    expect(actions).toEqual(["start", "cancel"]);
    // The keyup after a cancel stops nothing.
    keys.handle(key("keyup", "Meta", { ctrlKey: true }));
    expect(actions).toEqual(["start", "cancel"]);
  });

  test("while the text is on its way, or a button dictation runs, Esc is the dictation's only", () => {
    const { keys, actions, setBusy } = setup();
    setBusy(true);
    expect(keys.handle(key("keydown", "a"))).toBe(true);
    expect(keys.handle(key("keydown", "Escape"))).toBe(false);
    expect(actions).toEqual(["cancel"]);
  });

  test("losing the window cancels, before or after the hold", () => {
    const { keys, actions, holds, elapse, press } = setup();
    press();
    keys.blur();
    expect(holds[0]?.on).toBe(false);
    press();
    elapse();
    keys.blur();
    expect(actions).toEqual(["start", "cancel", "start", "cancel"]);
  });
});
