// The grid's state, apart from its page so links elsewhere can point into it without loading
// it.

// What a tile's header carries while dragged: its id. The grid's edges and the Mesa tabs take it.
export const TILE_MIME = "application/x-aos-tile";

// Each tile is a live xterm with its own share of the PTY output; six keep the page light.
export const MAX_TILES = 6;

// `node` marks a projects tree node and unfolds it in the rail.
export type GridSearch = {
  mesa?: string;
  t?: string;
  ids?: string;
  max?: string;
  node?: string;
  // Every Mesa at once instead of the open one's terminals (overview.tsx).
  view?: "mosaico" | "lienzo";
};

// A tile is a terminal, by its id, a checkout's git view, by its location, or the output of an
// env's commands, by the env's name. The key is encoded so its `/` and `:` stay inside one id
// and no `,` splits the grid's list.
const GIT = "git:";
const JOB = "job:";
const CODE = "code:";
const REC = "rec:";
const decoded = (id: string, prefix: string) => {
  if (!id.startsWith(prefix)) return null;
  try {
    return decodeURIComponent(id.slice(prefix.length)) || null;
  } catch {
    return null;
  }
};
export const gitTile = (location: string) => `${GIT}${encodeURIComponent(location)}`;
export const isGit = (id: string) => id.startsWith(GIT);
export const gitLocation = (id: string) => decoded(id, GIT);
export const jobTile = (env: string) => `${JOB}${encodeURIComponent(env)}`;
export const isJob = (id: string) => id.startsWith(JOB);
export const jobEnv = (id: string) => decoded(id, JOB);
export const codeTile = (location: string) => `${CODE}${encodeURIComponent(location)}`;
export const isCode = (id: string) => id.startsWith(CODE);
export const codeLocation = (id: string) => decoded(id, CODE);
// A recorded meeting, by the recording's id: the server places `rec:<id>` when one starts.
export const isRec = (id: string) => id.startsWith(REC);
export const recId = (id: string) => decoded(id, REC);
// A tile that is not a terminal: it takes no ticket and never needs the user.
export const isPanel = (id: string) => isGit(id) || isJob(id) || isCode(id) || isRec(id);
export type TileKind = "git" | "job" | "code" | "rec" | "terminal";
// What a tile shows, by its id; anything without a panel prefix is a terminal.
export const tileKind = (id: string): TileKind =>
  isGit(id) ? "git" : isJob(id) ? "job" : isCode(id) ? "code" : isRec(id) ? "rec" : "terminal";

// The grid's tiles from the search string: once each, in order, at most six. A slot's id is
// the layout's own and never a tile.
export function gridIds(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const ids = value.split(",").map((s) => s.trim());
  return [...new Set(ids.filter((id) => id && !isSlot(id)))].slice(0, MAX_TILES);
}

// The grid with one more terminal; a full grid stays as it is.
export const addTile = (ids: string[], id: string) =>
  ids.includes(id) || ids.length >= MAX_TILES ? ids : [...ids, id];

// Columns follow the count and the room the grid has: one on a narrow one, then two, then
// three from five tiles when they fit. It shapes the first layout; the user reshapes it.
// The same width as the stacking container query in grid.tsx (30rem).
export const NARROW = 480;
const WIDE = 960;
export type Shape = { cols: number; rows: number };
export function gridShape(n: number, width: number): Shape {
  const cols = width < NARROW || n <= 1 ? 1 : n <= 4 ? 2 : width >= WIDE ? 3 : 2;
  return { cols, rows: Math.max(1, Math.ceil(n / cols)) };
}

// The share a border leaves a track when the room is unknown.
export const MIN_SHARE = 0.05;
export const even = (count: number) => Array.from({ length: count }, () => 1 / count);

// Shares as kept: one positive number per track, summing to one. Anything else is even.
export function shares(value: unknown, count: number): number[] {
  if (
    count < 2 ||
    !Array.isArray(value) ||
    value.length !== count ||
    !value.every((v) => typeof v === "number" && Number.isFinite(v) && v > 0)
  )
    return even(count);
  const sum = value.reduce((a: number, b: number) => a + b, 0);
  return value.map((v: number) => v / sum);
}

// The border after track k moved by delta: only the two tracks beside it change, and neither
// goes below its floor (`min[i]`, MIN_SHARE when not given).
export function moveBorder(s: number[], k: number, delta: number, min: number[] = []): number[] {
  const a = s[k];
  const b = s[k + 1];
  if (a === undefined || b === undefined) return s;
  const pair = a + b;
  const lo = min[k] ?? MIN_SHARE;
  const hi = pair - (min[k + 1] ?? MIN_SHARE);
  if (lo > hi) return s;
  const next = Math.min(hi, Math.max(lo, a + delta));
  return s.map((v, i) => (i === k ? next : i === k + 1 ? pair - next : v));
}

// The layout: a tree of splits, tmux style. A row puts its kids side by side, a col stacks
// them; each split keeps its own shares. Leaves are the tiles, read depth first: that order
// numbers them. A leaf can also be a slot, an empty place a preset left for one more tile.
export type Split = { dir: "row" | "col"; kids: Layout[]; sizes: number[] };
export type Layout = { id: string } | Split;
export type Side = "left" | "right" | "top" | "bottom";
const isSplit = (n: Layout): n is Split => "kids" in n;

export function leaves(n: Layout | null): string[] {
  if (!n) return [];
  return isSplit(n) ? n.kids.flatMap(leaves) : [n.id];
}

const SLOT = "slot:";
export const isSlot = (id: string) => id.startsWith(SLOT);
// The terminals in the layout, in reading order, without the slots.
export const tiles = (n: Layout | null) => leaves(n).filter((id) => !isSlot(id));

// One split per level: a lone kid takes its parent's place, and a kid split the same way as
// its parent joins it, so three columns are one split with two borders.
function tidy(n: Layout): Layout | null {
  if (!isSplit(n)) return n;
  const kids: Layout[] = [];
  const sizes: number[] = [];
  n.kids.forEach((kid, i) => {
    const k = tidy(kid);
    const share = n.sizes[i] ?? 0;
    if (!k) return;
    if (isSplit(k) && k.dir === n.dir)
      k.kids.forEach((g, j) => {
        kids.push(g);
        sizes.push(share * (k.sizes[j] ?? 0));
      });
    else {
      kids.push(k);
      sizes.push(share);
    }
  });
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0] ?? null;
  return { dir: n.dir, kids, sizes: shares(sizes, kids.length) };
}

function prune(n: Layout, keep: (id: string) => boolean): Layout | null {
  if (!isSplit(n)) return keep(n.id) ? n : null;
  const kids: Layout[] = [];
  const sizes: number[] = [];
  n.kids.forEach((kid, i) => {
    const k = prune(kid, keep);
    if (k) {
      kids.push(k);
      sizes.push(n.sizes[i] ?? 0);
    }
  });
  return tidy({ dir: n.dir, kids, sizes });
}

const mapLeaves = (n: Layout, f: (id: string) => Layout): Layout =>
  isSplit(n) ? { ...n, kids: n.kids.map((k) => mapLeaves(k, f)) } : f(n.id);

const across = (side: Side) => (side === "left" || side === "right" ? "row" : "col");
const before = (side: Side) => side === "left" || side === "top";

// A tile beside `target`, on `side`, each with half of the target's place.
function beside(tree: Layout, target: string, id: string, side: Side): Layout {
  const tile = { id };
  const next = mapLeaves(tree, (x) =>
    x === target
      ? {
          dir: across(side),
          kids: before(side) ? [tile, { id: x }] : [{ id: x }, tile],
          sizes: [0.5, 0.5],
        }
      : { id: x },
  );
  return tidy(next) ?? tree;
}

// A tile moved beside another, taking half of its place, or along a whole side of the Mesa
// (`target` null), taking an even share. The tile itself or an unknown target changes nothing.
export function dock(tree: Layout, id: string, target: string | null, side: Side): Layout {
  if (id === target || !leaves(tree).includes(id)) return tree;
  if (target !== null && !leaves(tree).includes(target)) return tree;
  const rest = prune(tree, (x) => x !== id);
  if (!rest) return tree;
  if (target !== null) return beside(rest, target, id, side);
  const dir = across(side);
  const tile = { id };
  const m = isSplit(rest) && rest.dir === dir ? rest.kids.length : 1;
  const share = 1 / (m + 1);
  const kids = before(side) ? [tile, rest] : [rest, tile];
  const sizes = before(side) ? [share, 1 - share] : [1 - share, share];
  return tidy({ dir, kids, sizes }) ?? tree;
}

// A tile moved into a slot: it leaves its place, which closes, and takes the slot's.
export function fill(tree: Layout, slot: string, id: string): Layout {
  if (!isSlot(slot) || !leaves(tree).includes(slot) || !leaves(tree).includes(id)) return tree;
  const rest = prune(tree, (x) => x !== id);
  return rest ? mapLeaves(rest, (x) => ({ id: x === slot ? id : x })) : tree;
}

// A slot closed: its split shares its place out again.
export const closeSlot = (tree: Layout, slot: string): Layout | null =>
  prune(tree, (x) => x !== slot);

// Two tiles change places; the shape stays.
export function swap(tree: Layout, a: string, b: string): Layout {
  const ids = leaves(tree);
  if (a === b || !ids.includes(a) || !ids.includes(b)) return tree;
  return mapLeaves(tree, (x) => ({ id: x === a ? b : x === b ? a : x }));
}

// The split at `path` (kid indexes from the root) with new shares.
export function resizeSplit(tree: Layout, path: number[], sizes: number[]): Layout {
  if (!isSplit(tree)) return tree;
  const [i, ...rest] = path;
  if (i === undefined) return { ...tree, sizes: shares(sizes, tree.kids.length) };
  const kid = tree.kids[i];
  if (!kid) return tree;
  return { ...tree, kids: tree.kids.map((k, j) => (j === i ? resizeSplit(kid, rest, sizes) : k)) };
}

// The first layout for a set of tiles: rows of columns, as the grid looked before.
export function defaultLayout(ids: string[], width: number): Layout | null {
  const { cols } = gridShape(ids.length, width);
  const rows: Layout[] = [];
  for (let i = 0; i < ids.length; i += cols) {
    const row = ids.slice(i, i + cols).map((id) => ({ id }));
    rows.push({ dir: "row", kids: row, sizes: even(row.length) });
  }
  return tidy({ dir: "col", kids: rows, sizes: even(rows.length) });
}

// The ready-made layouts. Columnas: one row. Cuadrícula: rows of the same width, as square as
// the count allows, and the places left over in the last row are slots. Principal: the first
// tile at full height on the left, the others stacked beside it.
export type Preset = "columns" | "grid" | "main";
const row = (kids: Layout[]): Layout => ({ dir: "row", kids, sizes: even(kids.length) });
const col = (kids: Layout[]): Layout => ({ dir: "col", kids, sizes: even(kids.length) });

export function preset(kind: Preset, ids: string[]): Layout | null {
  const cells = ids.map((id) => ({ id }));
  const [first, ...rest] = cells;
  if (!first) return null;
  if (kind === "columns") return tidy(row(cells));
  if (kind === "main") return tidy(row([first, col(rest)]));
  const cols = Math.ceil(Math.sqrt(cells.length));
  const slots = Array.from(
    { length: cols * Math.ceil(cells.length / cols) - cells.length },
    (_, i) => ({
      id: `${SLOT}${i + 1}`,
    }),
  );
  const all = [...cells, ...slots];
  const rows: Layout[] = [];
  for (let i = 0; i < all.length; i += cols) rows.push(row(all.slice(i, i + cols)));
  return tidy(col(rows));
}

// A length as a share of the Mesa's box plus pixels, so the browser lays the tiles out from
// its own size, at once, with no measure: `calc(f × 100% + px)`.
export type Len = { f: number; px: number };
export type Rect = { x: Len; y: Len; w: Len; h: Len };
export const plus = (a: Len, b: Len): Len => ({ f: a.f + b.f, px: a.px + b.px });
export const times = (a: Len, k: number): Len => ({ f: a.f * k, px: a.px * k });
export const px = (px: number): Len => ({ f: 0, px });
export const lenAt = (l: Len, size: number) => l.f * size + l.px;
export const cssLen = (l: Len) => `calc(${l.f * 100}% + ${l.px}px)`;
// The Mesa's whole box, inside a padding.
export const inset = (pad: number): Rect => ({
  x: px(pad),
  y: px(pad),
  w: { f: 1, px: -2 * pad },
  h: { f: 1, px: -2 * pad },
});

// A border between kids k and k + 1 of the split at `path`: where it sits, the room its
// split shares out, the least pixels each kid needs (`need`) and the tiles on each side
// (`pair`), which name it.
export type Gap = {
  path: number[];
  k: number;
  axis: "x" | "y";
  at: Rect;
  room: Len;
  sizes: number[];
  need: number[];
  pair: [string[], string[]];
};

// A tile below this many pixels is no longer usable: its header and a few lines.
export const MIN_TILE = { w: 160, h: 120 };

// The least room a subtree needs along an axis.
function need(n: Layout, axis: "x" | "y", gap: number): number {
  const leaf = axis === "x" ? MIN_TILE.w : MIN_TILE.h;
  if (!isSplit(n)) return leaf;
  const spans = n.kids.map((k) => need(k, axis, gap));
  return (n.dir === "row") === (axis === "x")
    ? spans.reduce((a, b) => a + b, 0) + gap * (n.kids.length - 1)
    : Math.max(...spans);
}

// The share floor of each track beside a border once its room is known in pixels.
export const floors = (g: Gap, room: number) =>
  g.need.map((n) => (room > 0 ? Math.min(0.5, n / room) : MIN_SHARE));

// Where every tile and every border sits inside `box`, with `gap` pixels between tiles.
export function layoutRects(tree: Layout | null, box: Rect, gap: number) {
  const tiles = new Map<string, Rect>();
  const gaps: Gap[] = [];
  const walk = (n: Layout, r: Rect, path: number[]) => {
    if (!isSplit(n)) return void tiles.set(n.id, r);
    const axis = n.dir === "row" ? "x" : "y";
    const room = plus(axis === "x" ? r.w : r.h, px(-gap * (n.kids.length - 1)));
    const needs = n.kids.map((k) => need(k, axis, gap));
    let at = axis === "x" ? r.x : r.y;
    n.kids.forEach((kid, i) => {
      const span = times(room, n.sizes[i] ?? 0);
      walk(kid, axis === "x" ? { ...r, x: at, w: span } : { ...r, y: at, h: span }, [...path, i]);
      at = plus(at, span);
      if (i < n.kids.length - 1) {
        const line = axis === "x" ? { ...r, x: at, w: px(gap) } : { ...r, y: at, h: px(gap) };
        const pair: [string[], string[]] = [leaves(kid), leaves(n.kids[i + 1] ?? null)];
        gaps.push({ path, k: i, axis, at: line, room, sizes: n.sizes, need: needs, pair });
        at = plus(at, px(gap));
      }
    });
  };
  if (tree) walk(tree, box, []);
  return { tiles, gaps };
}

// The layout for the tiles in the Mesa: the kept one without the tiles that left it, and each
// new tile in the first slot, or beside the largest tile, along its longer side. Nothing kept,
// or only slots, gives the first layout.
export function reconcile(
  kept: Layout | null,
  ids: string[],
  box: { w: number; h: number },
): Layout | null {
  const want = new Set(ids);
  let tree = kept ? prune(kept, (x) => want.has(x) || isSlot(x)) : null;
  if (tiles(tree).length === 0) return defaultLayout(ids, box.w);
  const w = box.w || 16;
  const h = box.h || 9;
  for (const id of ids) {
    if (!tree || leaves(tree).includes(id)) continue;
    const slot = leaves(tree).find(isSlot);
    if (slot) {
      tree = mapLeaves(tree, (x) => ({ id: x === slot ? id : x }));
      continue;
    }
    let big: { id: string; w: number; h: number } | undefined;
    for (const [leaf, r] of layoutRects(tree, inset(0), 0).tiles) {
      const tile = { id: leaf, w: lenAt(r.w, w), h: lenAt(r.h, h) };
      if (!big || tile.w * tile.h >= big.w * big.h) big = tile;
    }
    if (big) tree = beside(tree, big.id, id, big.w >= big.h ? "right" : "bottom");
  }
  return tree;
}

// Where a tile dropped at (x, y) inside a w × h tile goes: beside it on the nearest side when
// the pointer is near that edge, or in its place.
export function dropSide(x: number, y: number, w: number, h: number): Side | "center" {
  const near: [Side, number][] = [
    ["left", x / w],
    ["right", 1 - x / w],
    ["top", y / h],
    ["bottom", 1 - y / h],
  ];
  const [side, d] = near.reduce((a, b) => (b[1] < a[1] ? b : a));
  return d < 0.3 ? side : "center";
}

// A stored value that is not a sound tree reads as nothing.
function parseLayout(value: unknown, depth: number): Layout | null {
  if (!value || typeof value !== "object" || depth > 8) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id === "string" && v.id) return { id: v.id };
  if ((v.dir !== "row" && v.dir !== "col") || !Array.isArray(v.kids) || v.kids.length < 2)
    return null;
  const kids = v.kids.map((k) => parseLayout(k, depth + 1));
  if (!kids.every((k): k is Layout => k !== null)) return null;
  return { dir: v.dir, kids, sizes: shares(v.sizes, kids.length) };
}

export function readLayout(value: unknown): Layout | null {
  const tree = parseLayout(value, 0);
  const ids = leaves(tree);
  return tree && new Set(ids).size === ids.length ? tidy(tree) : null;
}
