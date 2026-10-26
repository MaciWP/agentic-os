import { describe, expect, test } from "bun:test";
import { clockTime, minSec, plural, relativeTime } from "./format.ts";

describe("plural", () => {
  test("picks the word by count and writes the number the Spanish way", () => {
    expect(plural(1, "nota", "notas")).toBe("1 nota");
    expect(plural(0, "nota", "notas")).toBe("0 notas");
    expect(plural(12_345, "llamada", "llamadas")).toBe("12.345 llamadas");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-09-30T12:00:00Z");
  test("formats past times in Spanish", () => {
    expect(relativeTime("2026-09-28T12:00:00Z", now)).toBe("anteayer");
    expect(relativeTime("2026-09-30T11:59:30Z", now)).toBe("ahora");
  });
  test("returns empty text for an invalid date", () => {
    expect(relativeTime("not a date", now)).toBe("");
  });
});

describe("clockTime", () => {
  test("writes hours and minutes the Spanish way, from a timestamp or an ISO string", () => {
    const at = new Date(2026, 9, 8, 7, 5).getTime();
    expect(clockTime(at)).toBe("07:05");
    expect(clockTime(new Date(at).toISOString())).toBe("07:05");
  });
});

describe("minSec", () => {
  test("writes minutes and two-digit seconds", () => {
    expect(minSec(0)).toBe("0:00");
    expect(minSec(65)).toBe("1:05");
    expect(minSec(3600)).toBe("60:00");
  });
});
