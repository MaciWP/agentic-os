import { expect, test } from "bun:test";
import { CARD, canvasLayout, detailAt, fit, reveal, ZOOM, zoomAt } from "./canvas-layout.ts";

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test("each block is a band under the last; its Mesas sit side by side and wrap", () => {
  const mesas = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, cards: ["a", "b"] }));
  const l = canvasLayout([
    { key: "work", mesas: mesas(5, "w") },
    { key: "empty", mesas: [] },
    { key: "", mesas: [{ id: "loose", cards: [] }] },
  ]);
  expect(l.bands.map((b) => b.key)).toEqual(["work", ""]);
  const [work, loose] = l.bands;
  if (!work || !loose) throw new Error("no bands");
  expect(loose.y).toBeGreaterThan(work.y + work.h);
  // Five two-card Mesas do not fit one row: the last ones wrap under the first.
  const rows = new Set(l.frames.filter((f) => f.id.startsWith("w")).map((f) => f.y));
  expect(rows.size).toBe(2);
  for (const f of l.frames)
    for (const g of l.frames) if (f !== g) expect(overlaps(f, g)).toBe(false);
  // A Mesa without terminals keeps one card's room.
  const empty = l.frames.find((f) => f.id === "loose");
  expect(empty?.w).toBeGreaterThan(CARD.w);
  expect(l.w).toBe(Math.max(...l.bands.map((b) => b.w)));
});

test("a Mesa's cards stay inside its frame, two columns at most", () => {
  const l = canvasLayout([{ key: "b", mesas: [{ id: "m", cards: ["1", "2", "3", "4", "5"] }] }]);
  const frame = l.frames[0];
  if (!frame) throw new Error("no frame");
  expect(new Set(l.cards.map((c) => c.x)).size).toBe(2);
  expect(new Set(l.cards.map((c) => c.y)).size).toBe(3);
  for (const c of l.cards) {
    expect(c.mesa).toBe("m");
    expect(c.x >= frame.x && c.x + c.w <= frame.x + frame.w).toBe(true);
    expect(c.y >= frame.y && c.y + c.h <= frame.y + frame.h).toBe(true);
  }
});

test("fit shows everything, never past 1:1, and an empty Lienzo keeps the default", () => {
  const big = fit({ w: 4000, h: 1000 }, { w: 1000, h: 600 });
  expect(big.z).toBeCloseTo((1000 - 64) / 4000);
  expect(big.x).toBeCloseTo((1000 - 4000 * big.z) / 2);
  expect(fit({ w: 100, h: 100 }, { w: 1000, h: 600 }).z).toBe(1);
  expect(fit({ w: 99_999, h: 10 }, { w: 1000, h: 600 }).z).toBe(ZOOM.min);
  expect(fit({ w: 0, h: 0 }, { w: 1000, h: 600 })).toEqual({ x: 32, y: 32, z: 1 });
});

test("zooming keeps the point under the pointer, within the limits", () => {
  const c = { x: 100, y: 50, z: 1 };
  const next = zoomAt(c, 2, 400, 300);
  expect(next.z).toBe(ZOOM.max);
  // The Lienzo's point under (400, 300) is the same before and after.
  expect((400 - next.x) / next.z).toBeCloseTo((400 - c.x) / c.z);
  expect((300 - next.y) / next.z).toBeCloseTo((300 - c.y) / c.z);
  expect(zoomAt(c, 0.01, 0, 0).z).toBe(ZOOM.min);
});

test("reveal moves the least to bring a card into sight, and not at all when it shows", () => {
  const view = { w: 800, h: 600 };
  const c = { x: 0, y: 0, z: 1 };
  expect(reveal(c, { x: 100, y: 100, w: 200, h: 100 }, view)).toBe(c);
  const right = reveal(c, { x: 900, y: 100, w: 200, h: 100 }, view);
  expect(right.x).toBe(800 - 24 - 1100);
  expect(right.y).toBe(0);
  const up = reveal({ x: 0, y: -500, z: 1 }, { x: 10, y: 100, w: 100, h: 100 }, view);
  expect(up.y).toBe(-500 + (24 - (100 - 500)));
});

test("the cards say more as the camera comes closer", () => {
  expect(detailAt(0.2)).toBe("far");
  // A whole workspace fits near 0.5: names only, still readable.
  expect(detailAt(0.5)).toBe("far");
  expect(detailAt(0.8)).toBe("mid");
  expect(detailAt(1.2)).toBe("near");
});
