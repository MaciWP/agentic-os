import { describe, expect, test } from "bun:test";
import { terminalMenu } from "./phone-chrome.tsx";

describe("«Reiniciar»", () => {
  test("the phone menu offers it only while it can restart", () => {
    const menu = (onRestart: false | (() => void)) =>
      terminalMenu({
        id: "t1",
        reading: null,
        onView: () => {},
        agent: true,
        onMessage: false,
        onRename: false,
        onRestart,
        onStop: false,
      });
    expect(menu(() => {})).toContainEqual(expect.objectContaining({ label: "Reiniciar" }));
    expect(menu(false)).not.toContainEqual(expect.objectContaining({ label: "Reiniciar" }));
  });
});
