import { describe, expect, test } from "bun:test";
import { PROJECT_COLORS, projectColor } from "./project-colors.ts";

describe("projectColor", () => {
  test("the configured colour wins", () => {
    expect(projectColor("alpha", { alpha: "orange" })).toBe("orange");
    expect(projectColor("alpha", { beta: "orange" })).toBe(projectColor("alpha"));
  });

  test("without one, the name picks a colour of the palette, the same every time", () => {
    const names = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
    for (const name of names) {
      expect(PROJECT_COLORS).toContain(projectColor(name));
      expect(projectColor(name)).toBe(projectColor(name));
    }
    // Not one colour for all: the hash spreads names over the palette.
    expect(new Set(names.map((n) => projectColor(n))).size).toBeGreaterThan(3);
  });
});
