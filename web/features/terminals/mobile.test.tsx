import { expect, test } from "bun:test";
import { memoryStorage } from "../../test-storage.ts";
import { savedFontSize, savedTouchView, sends } from "./mobile.tsx";

test("the phone's view and letter size move from their old names and keep their bounds", () => {
  const disk = memoryStorage("local", {
    "terminal-touch-view": "terminal",
    "terminal-font-size": "17",
  });
  try {
    expect(savedTouchView()).toBe("terminal");
    expect(savedFontSize()).toBe(17);
    expect(Object.fromEntries(disk.data)).toEqual({
      "aos.terminal-touch-view": "terminal",
      "aos.terminal-font-size": "17",
    });
    for (const size of ["8", "21", "12.5", "big", ""]) {
      disk.data.set("aos.terminal-font-size", size);
      expect(savedFontSize()).toBe(13);
    }
    disk.data.set("aos.terminal-touch-view", "other");
    expect(savedTouchView()).toBe("read");
  } finally {
    disk.restore();
  }
});

test("a send not yet confirmed keeps its request id under the new name", () => {
  const disk = memoryStorage("local", { "aos.message.draft:t1:request": "r-1" });
  try {
    expect(sends.get("t1")).toBe("r-1");
    expect(Object.fromEntries(disk.data)).toEqual({ "aos.message.request:t1": "r-1" });
    expect(sends.remove("t1")).toBe(true);
    expect(disk.data.size).toBe(0);
  } finally {
    disk.restore();
  }
});
