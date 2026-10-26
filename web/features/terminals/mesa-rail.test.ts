import { expect, test } from "bun:test";
import { memoryStorage } from "../../test-storage.ts";
import { railWidths } from "./mesa-rail.tsx";

test("a rail width kept under the old unprefixed name moves to the aos. one", () => {
  const disk = memoryStorage("local", { "rail-width:mesa-left": "420", "rail-width:bad": "wide" });
  try {
    expect(railWidths.get("mesa-left")).toBe(420);
    expect(railWidths.get("bad")).toBe(0);
    expect(railWidths.get("none")).toBe(0);
    expect(disk.data.get("aos.rail-width:mesa-left")).toBe("420");
    expect(disk.data.has("rail-width:mesa-left")).toBe(false);
  } finally {
    disk.restore();
  }
});
