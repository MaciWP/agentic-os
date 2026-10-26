import { describe, expect, jest, test } from "bun:test";
import { nextRise, spinRef, turn } from "./motion.ts";

describe("nextRise", () => {
  test("counts a growing count, not a falling or unchanged one", () => {
    const start = { n: 0, rise: 0 };
    const up = nextRise(start, 2);
    expect(up).toEqual({ n: 2, rise: 1 });
    expect(nextRise(up, 2)).toBe(up);
    const down = nextRise(up, 1);
    expect(down).toEqual({ n: 1, rise: 1 });
    expect(nextRise(down, 3)).toEqual({ n: 3, rise: 2 });
  });
});

describe("spinRef", () => {
  const el = () => ({ style: { transform: "" } }) as HTMLElement;

  test("one timer turns every spinner to the same angle and stops with the last one", () => {
    jest.useFakeTimers();
    try {
      const a = el();
      const b = el();
      const dropA = spinRef(a);
      const dropB = spinRef(b);
      jest.advanceTimersByTime(250);
      expect(a.style.transform).toMatch(/^rotate\(\d+deg\)$/);
      expect(b.style.transform).toBe(a.style.transform);
      dropA();
      // A span that stays for the next phase's icon stands upright and no longer turns.
      expect(a.style.transform).toBe("");
      const was = b.style.transform;
      jest.advanceTimersByTime(125);
      expect(b.style.transform).not.toBe(was);
      expect(a.style.transform).toBe("");
      dropB();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a step is 45°, and the eighth comes back to the start", () => {
    const a = el();
    const drop = spinRef(a);
    const start = a.style.transform;
    turn();
    const next = a.style.transform;
    const deg = (t: string) => Number(t.match(/-?\d+/)?.[0]);
    expect((deg(next) - deg(start) + 360) % 360).toBe(45);
    for (let i = 0; i < 7; i++) turn();
    expect(a.style.transform).toBe(start);
    drop();
  });

  test("under reduced motion the icon stands still and no timer runs", () => {
    const g = globalThis as { matchMedia?: unknown };
    g.matchMedia = (query: string) => ({ matches: query.includes("reduce") });
    jest.useFakeTimers();
    try {
      const a = el();
      const drop = spinRef(a);
      expect(a.style.transform).toBe("");
      expect(jest.getTimerCount()).toBe(0);
      drop();
    } finally {
      jest.useRealTimers();
      delete g.matchMedia;
    }
  });
});
