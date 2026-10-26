import { expect, test } from "bun:test";
import { hooksValue } from "./poneglyph.tsx";

test("no hook ran is no data, never 'no failures'", () => {
  expect(hooksValue({ runs: 0, failures: 0 })).toBe("Sin datos");
  expect(hooksValue({ runs: 12, failures: 0 })).toBe("Sin fallos");
  expect(hooksValue({ runs: 12, failures: 3 })).toBe("3 fallos");
});
