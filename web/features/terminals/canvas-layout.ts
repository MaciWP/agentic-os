// Where the Lienzo puts things, in its own units, and how its camera moves: pure, so the
// tests check it without a browser.

// A terminal's card. Its size never changes with the zoom: only what it shows does.
export const CARD = { w: 248, h: 140 };
const GAP = 12;
// Inside a Mesa's frame: its edge, and its title over the cards.
const PAD = 12;
const HEAD = 36;
// A block's band: its title, the room between Mesas, and between bands.
const BAND_HEAD = 40;
const SPACE = 28;
const BAND_GAP = 48;
// A band wraps its Mesas past this width.
const ROW = 1720;

export type Rect = { x: number; y: number; w: number; h: number };
export type CanvasBand = { key: string; mesas: { id: string; cards: string[] }[] };
export type CanvasLayout = {
  bands: (Rect & { key: string })[];
  frames: (Rect & { id: string })[];
  cards: (Rect & { id: string; mesa: string })[];
  w: number;
  h: number;
};

// A band per block, one under another; in each, its Mesas side by side, wrapping; in each Mesa,
// its terminals in up to two columns. A Mesa without terminals keeps one card's room.
export function canvasLayout(bands: CanvasBand[]): CanvasLayout {
  const out: CanvasLayout = { bands: [], frames: [], cards: [], w: 0, h: 0 };
  let y = 0;
  for (const band of bands) {
    if (!band.mesas.length) continue;
    const top = y;
    let x = 0;
    let row = top + BAND_HEAD;
    let tallest = 0;
    let width = 0;
    for (const m of band.mesas) {
      const n = Math.max(1, m.cards.length);
      const cols = Math.min(2, n);
      const rows = Math.ceil(n / cols);
      const w = 2 * PAD + cols * CARD.w + (cols - 1) * GAP;
      const h = HEAD + PAD + rows * CARD.h + (rows - 1) * GAP;
      if (x > 0 && x + w > ROW) {
        x = 0;
        row += tallest + SPACE;
        tallest = 0;
      }
      out.frames.push({ id: m.id, x, y: row, w, h });
      m.cards.forEach((id, i) => {
        out.cards.push({
          id,
          mesa: m.id,
          x: x + PAD + (i % cols) * (CARD.w + GAP),
          y: row + HEAD + Math.floor(i / cols) * (CARD.h + GAP),
          ...CARD,
        });
      });
      width = Math.max(width, x + w);
      x += w + SPACE;
      tallest = Math.max(tallest, h);
    }
    const bottom = row + tallest;
    out.bands.push({ key: band.key, x: 0, y: top, w: width, h: bottom - top });
    out.w = Math.max(out.w, width);
    out.h = bottom;
    y = bottom + BAND_GAP;
  }
  return out;
}

// The camera: the Lienzo's point at the viewport's top left corner is (-x / z, -y / z).
export type Camera = { x: number; y: number; z: number };
export const ZOOM = { min: 0.2, max: 1.5 };
export const clampZoom = (z: number) => Math.min(ZOOM.max, Math.max(ZOOM.min, z));
type Size = { w: number; h: number };

// Everything in sight, never closer than 1:1; a tall Lienzo starts at its top.
export function fit(box: Size, view: Size, margin = 32): Camera {
  if (box.w <= 0 || box.h <= 0 || view.w <= 0 || view.h <= 0) return { x: margin, y: margin, z: 1 };
  const z = clampZoom(Math.min((view.w - 2 * margin) / box.w, (view.h - 2 * margin) / box.h, 1));
  return { z, x: (view.w - box.w * z) / 2, y: Math.max(margin, (view.h - box.h * z) / 2) };
}

// A new zoom that keeps the point under the viewport's (px, py) where it is.
export function zoomAt(c: Camera, z: number, px: number, py: number): Camera {
  const next = clampZoom(z);
  return { z: next, x: px - ((px - c.x) * next) / c.z, y: py - ((py - c.y) * next) / c.z };
}

// The least move that brings a rect of the Lienzo into the viewport.
export function reveal(c: Camera, r: Rect, view: Size, margin = 24): Camera {
  const left = c.x + r.x * c.z;
  const top = c.y + r.y * c.z;
  const right = left + r.w * c.z;
  const bottom = top + r.h * c.z;
  const dx = left < margin ? margin - left : right > view.w - margin ? view.w - margin - right : 0;
  const dy = top < margin ? margin - top : bottom > view.h - margin ? view.h - margin - bottom : 0;
  return dx || dy ? { ...c, x: c.x + dx, y: c.y + dy } : c;
}

// What a card shows at a zoom: far, its harness and name; mid, also its task and last words;
// near, also what it asks and where it works. A level shows only once its smallest text (11 px
// on the card) reads at about 8 px on screen: below 0.7 the card keeps to its 26 px name.
export type Detail = "far" | "mid" | "near";
export const detailAt = (z: number): Detail => (z < 0.7 ? "far" : z < 1.05 ? "mid" : "near");
