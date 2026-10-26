import { describe, expect, test } from "bun:test";
import {
  addTile,
  closeSlot,
  codeLocation,
  codeTile,
  defaultLayout,
  dock,
  dropSide,
  fill,
  floors,
  gitLocation,
  gitTile,
  gridIds,
  gridShape,
  inset,
  isPanel,
  jobEnv,
  jobTile,
  type Layout,
  layoutRects,
  leaves,
  lenAt,
  MAX_TILES,
  MIN_SHARE,
  MIN_TILE,
  moveBorder,
  preset,
  type Rect,
  readLayout,
  reconcile,
  resizeSplit,
  shares,
  swap,
  tileKind,
  tiles,
} from "./grid-state.ts";

describe("grid state", () => {
  test("a slot's id never reads as a terminal", () => {
    expect(gridIds("a,slot:1,b")).toEqual(["a", "b"]);
  });

  test("ids come once each, in order, without blanks, at most six", () => {
    expect(gridIds("b, a,,b ,c")).toEqual(["b", "a", "c"]);
    expect(gridIds("1,2,3,4,5,6,7,8")).toHaveLength(MAX_TILES);
    expect(gridIds(undefined)).toEqual([]);
    expect(gridIds(["a"])).toEqual([]);
  });

  test("a checkout's git is a tile id of its own that keeps its location whole", () => {
    const id = gitTile("wt:alpha:fix/a,b");
    expect(id).toBe("git:wt%3Aalpha%3Afix%2Fa%2Cb");
    expect(gitLocation(id)).toBe("wt:alpha:fix/a,b");
    expect(gitLocation("a1")).toBeNull();
    expect(gitLocation("git:%E0")).toBeNull();
    expect(gridIds(`a,${id},slot:1`)).toEqual(["a", id]);
    const tree = reconcile(null, ["a", id], { w: 1200, h: 800 });
    expect(tiles(tree)).toEqual(["a", id]);
  });

  test("an env's output is a tile id of its own too, and both are panels, not terminals", () => {
    const id = jobTile("env-a");
    expect(id).toBe("job:env-a");
    expect(jobEnv(id)).toBe("env-a");
    expect(jobEnv(gitTile("env-a"))).toBeNull();
    expect(jobEnv("job:%E0")).toBeNull();
    expect(gridIds(`a,${id}`)).toEqual(["a", id]);
    expect([id, gitTile("app"), "a1"].map(isPanel)).toEqual([true, true, false]);
  });

  test("a checkout's code is a panel too, and every id says what it shows", () => {
    const id = codeTile("env:e1/front");
    expect(id).toBe("code:env%3Ae1%2Ffront");
    expect(codeLocation(id)).toBe("env:e1/front");
    expect(codeLocation(gitTile("app"))).toBeNull();
    expect(isPanel(id)).toBe(true);
    expect([id, gitTile("a"), jobTile("e"), "a1"].map(tileKind)).toEqual([
      "code",
      "git",
      "job",
      "terminal",
    ]);
  });

  test("a tile is added once, and never to a full grid", () => {
    expect(addTile(["a"], "b")).toEqual(["a", "b"]);
    expect(addTile(["a", "b"], "a")).toEqual(["a", "b"]);
    const full = ["1", "2", "3", "4", "5", "6"];
    expect(addTile(full, "7")).toBe(full);
  });

  test("columns follow the count and the room: one when narrow, three from five tiles when wide", () => {
    const cols = (width: number) => [1, 2, 3, 4, 5, 6].map((n) => gridShape(n, width).cols);
    expect(cols(1200)).toEqual([1, 2, 2, 2, 3, 3]);
    expect(cols(800)).toEqual([1, 2, 2, 2, 2, 2]);
    expect(cols(500)).toEqual([1, 2, 2, 2, 2, 2]);
    expect(cols(470)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(gridShape(5, 1200)).toEqual({ cols: 3, rows: 2 });
    expect(gridShape(3, 800)).toEqual({ cols: 2, rows: 2 });
    expect(gridShape(0, 1200)).toEqual({ cols: 1, rows: 1 });
  });

  test("kept shares are positive and sum to one; any other value gives even tracks", () => {
    expect(shares([0.5, 0.5], 2)).toEqual([0.5, 0.5]);
    const [x = 0, y = 0] = shares([3, 1], 2);
    expect(x).toBeCloseTo(0.75);
    expect(y).toBeCloseTo(0.25);
    for (const bad of [undefined, "0.5,0.5", [0.5], [0.5, Number.NaN], [0.5, "0.5"], [1, 0], {}])
      expect(shares(bad, 2)).toEqual([0.5, 0.5]);
    expect(shares([0.7, 0.3], 3)).toHaveLength(3);
    expect(shares([0.7, 0.3], 1)).toEqual([1]);
  });

  test("a border moves only its two tracks, never below their floors", () => {
    const [a = 0, b = 0, c = 0] = moveBorder([1 / 3, 1 / 3, 1 / 3], 0, 0.1);
    expect(a).toBeCloseTo(1 / 3 + 0.1);
    expect(b).toBeCloseTo(1 / 3 - 0.1);
    expect(c).toBeCloseTo(1 / 3);
    const [x = 0, y = 0] = moveBorder([0.5, 0.5], 0, 0.9);
    expect(y).toBeCloseTo(MIN_SHARE);
    expect(x + y).toBeCloseTo(1);
    const [, z = 0] = moveBorder([0.5, 0.5], 0, 0.9, [0.1, 0.3]);
    expect(z).toBeCloseTo(0.3);
    expect(moveBorder([0.5, 0.5], 1, 0.1)).toEqual([0.5, 0.5]);
  });
});

const row = (...kids: Layout[]): Layout => ({
  dir: "row",
  kids,
  sizes: kids.map(() => 1 / kids.length),
});
const col = (...kids: Layout[]): Layout => ({
  dir: "col",
  kids,
  sizes: kids.map(() => 1 / kids.length),
});
const t = (id: string): Layout => ({ id });
const BOX = { x: 0, y: 0, w: 1200, h: 800 };

describe("layout", () => {
  test("the first layout is rows of columns as the grid had, the last row full width", () => {
    expect(defaultLayout([], 1200)).toBeNull();
    expect(defaultLayout(["a"], 1200)).toEqual(t("a"));
    expect(defaultLayout(["a", "b"], 1200)).toEqual(row(t("a"), t("b")));
    expect(defaultLayout(["a", "b", "c"], 1200)).toEqual(col(row(t("a"), t("b")), t("c")));
    expect(defaultLayout(["a", "b", "c", "d", "e"], 1200)).toEqual(
      col(row(t("a"), t("b"), t("c")), row(t("d"), t("e"))),
    );
    expect(defaultLayout(["a", "b"], 500)).toEqual(row(t("a"), t("b")));
    expect(defaultLayout(["a", "b"], 470)).toEqual(col(t("a"), t("b")));
  });

  test("a tile dropped beside another takes half of its place; the same direction joins the split", () => {
    const tree = row(t("a"), t("b"));
    expect(dock(tree, "a", "b", "bottom")).toEqual(col(t("b"), t("a")));
    const three = dock(dock(tree, "a", "b", "bottom"), "a", "b", "right");
    expect(three).toEqual(row(t("b"), t("a")));
    const split = dock(row(t("a"), t("b"), t("c")), "c", "b", "bottom");
    expect(split).toEqual({
      dir: "row",
      kids: [t("a"), col(t("b"), t("c"))],
      sizes: [0.5, 0.5],
    });
    const beside = dock(col(t("a"), t("b")), "b", "a", "left");
    expect(beside).toEqual(row(t("b"), t("a")));
    const inRow = dock(row(t("a"), t("b"), t("c")), "a", "c", "right");
    expect(leaves(inRow)).toEqual(["b", "c", "a"]);
    if (!("kids" in inRow)) throw new Error("a split");
    expect(inRow.sizes.map((v) => Math.round(v * 100))).toEqual([50, 25, 25]);
  });

  test("a tile dropped on a side of the Mesa runs along all of it with an even share", () => {
    const tree = row(t("a"), t("b"), t("c"));
    const bottom = dock(tree, "c", null, "bottom");
    expect(bottom).toEqual({ dir: "col", kids: [row(t("a"), t("b")), t("c")], sizes: [0.5, 0.5] });
    const left = dock(col(row(t("a"), t("b")), t("c")), "c", null, "left");
    expect(leaves(left)).toEqual(["c", "a", "b"]);
    if (!("kids" in left)) throw new Error("a split");
    expect(left.sizes.map((v) => Math.round(v * 300))).toEqual([100, 100, 100]);
  });

  test("a drop on itself, an unknown tile or a lone tile changes nothing", () => {
    const tree = row(t("a"), t("b"));
    expect(dock(tree, "a", "a", "left")).toBe(tree);
    expect(dock(tree, "z", "a", "left")).toBe(tree);
    expect(dock(tree, "a", "z", "left")).toBe(tree);
    expect(dock(t("a"), "a", null, "left")).toEqual(t("a"));
  });

  test("two tiles change places and the shape stays; unknown ones leave it", () => {
    const tree = col(row(t("a"), t("b")), t("c"));
    expect(swap(tree, "a", "c")).toEqual(col(row(t("c"), t("b")), t("a")));
    expect(swap(tree, "a", "z")).toBe(tree);
    expect(swap(tree, "a", "a")).toBe(tree);
  });

  test("one split resizes and nothing else", () => {
    const tree = col(row(t("a"), t("b")), row(t("c"), t("d")));
    const next = resizeSplit(tree, [1], [0.7, 0.3]);
    if (!("kids" in next)) throw new Error("a split");
    expect(next.kids[0]).toEqual(row(t("a"), t("b")));
    expect(next.kids[1]).toEqual({ dir: "row", kids: [t("c"), t("d")], sizes: [0.7, 0.3] });
    expect(resizeSplit(tree, [5], [0.7, 0.3])).toBe(tree);
  });

  test("tiles and borders fill the box exactly, gaps between them, at any size", () => {
    const tree = col(row(t("a"), t("b")), t("c"));
    const { tiles, gaps } = layoutRects(tree, inset(12), 12);
    // In pixels on a 1036 × 636 Mesa: 12 of padding around, 12 between tiles.
    const at = (r: Rect | undefined) =>
      r && {
        x: lenAt(r.x, 1036),
        y: lenAt(r.y, 636),
        w: lenAt(r.w, 1036),
        h: lenAt(r.h, 636),
      };
    expect(at(tiles.get("a"))).toEqual({ x: 12, y: 12, w: 500, h: 300 });
    expect(at(tiles.get("b"))).toEqual({ x: 524, y: 12, w: 500, h: 300 });
    expect(at(tiles.get("c"))).toEqual({ x: 12, y: 324, w: 1012, h: 300 });
    expect(gaps).toHaveLength(2);
    const across = gaps.find((g) => g.axis === "y");
    expect(at(across?.at)).toEqual({ x: 12, y: 312, w: 1012, h: 12 });
    expect(across?.pair).toEqual([["a", "b"], ["c"]]);
    const between = gaps.find((g) => g.axis === "x");
    expect(between?.path).toEqual([0]);
    expect(between && lenAt(between.room, 1036)).toBe(1000);
    // The same layout on another size keeps its shares and its pixel gaps.
    expect(lenAt(tiles.get("b")?.w ?? { f: 0, px: 0 }, 2036)).toBe(1000);
    expect(layoutRects(null, inset(0), 12).tiles.size).toBe(0);
  });

  test("a border keeps every tile beside it at least a usable size, counting the tiles inside", () => {
    const [flat] = layoutRects(row(t("a"), t("b"), t("c")), inset(0), 0).gaps;
    expect(flat && floors(flat, 1000)).toEqual([0.16, 0.16, 0.16]);
    const nested = layoutRects(row(t("a"), col(t("b"), row(t("c"), t("d")))), inset(0), 10).gaps;
    const top = nested.find((g) => g.path.length === 0);
    expect(top && floors(top, 1190)[1]).toBeCloseTo((2 * MIN_TILE.w + 10) / 1190);
    // Never more than half: two tracks always keep a border that moves.
    expect(flat && floors(flat, 100)).toEqual([0.5, 0.5, 0.5]);
  });

  test("the kept layout follows the tiles: gone ones leave, new ones split the largest", () => {
    const kept = col(row(t("a"), t("b")), t("c"));
    expect(reconcile(kept, ["a", "b", "c"], BOX)).toEqual(kept);
    expect(reconcile(kept, ["a", "c"], BOX)).toEqual(col(t("a"), t("c")));
    expect(reconcile(kept, ["b"], BOX)).toEqual(t("b"));
    // c is the largest; it is wider than tall, so d goes to its right.
    const added = reconcile(kept, ["a", "b", "c", "d"], BOX);
    expect(added).toEqual(col(row(t("a"), t("b")), row(t("c"), t("d"))));
    expect(reconcile(null, ["a", "b"], BOX)).toEqual(row(t("a"), t("b")));
    expect(reconcile(kept, ["x", "y"], BOX)).toEqual(row(t("x"), t("y")));
    expect(reconcile(kept, [], BOX)).toBeNull();
  });

  test("presets: one row, a grid whose last row ends in slots, or one tall tile beside a stack", () => {
    expect(preset("columns", [])).toBeNull();
    expect(preset("grid", ["a"])).toEqual(t("a"));
    expect(preset("columns", ["a", "b", "c"])).toEqual(row(t("a"), t("b"), t("c")));
    expect(preset("main", ["a", "b"])).toEqual(row(t("a"), t("b")));
    expect(preset("main", ["a", "b", "c"])).toEqual(row(t("a"), col(t("b"), t("c"))));
    expect(preset("grid", ["a", "b"])).toEqual(row(t("a"), t("b")));
    expect(preset("grid", ["a", "b", "c"])).toEqual(
      col(row(t("a"), t("b")), row(t("c"), t("slot:1"))),
    );
    expect(preset("grid", ["a", "b", "c", "d"])).toEqual(
      col(row(t("a"), t("b")), row(t("c"), t("d"))),
    );
    expect(preset("grid", ["a", "b", "c", "d", "e"])).toEqual(
      col(row(t("a"), t("b"), t("c")), row(t("d"), t("e"), t("slot:1"))),
    );
    const six = preset("grid", ["a", "b", "c", "d", "e", "f"]);
    expect(leaves(six)).toEqual(["a", "b", "c", "d", "e", "f"]);
    // Every preset keeps the tiles in the order given, and only the grid adds slots.
    for (const kind of ["columns", "grid", "main"] as const)
      for (let n = 2; n <= 6; n++) {
        const ids = "abcdef".slice(0, n).split("");
        expect(tiles(preset(kind, ids))).toEqual(ids);
      }
  });

  test("a slot takes the next tile, a tile moved into it leaves its place, and it closes", () => {
    const grid = col(row(t("a"), t("b")), row(t("c"), t("slot:1")));
    expect(tiles(grid)).toEqual(["a", "b", "c"]);
    // A slot stays while its tiles do, and the next tile takes it instead of splitting one.
    expect(reconcile(grid, ["a", "b", "c"], BOX)).toEqual(grid);
    expect(reconcile(grid, ["a", "b", "c", "d"], BOX)).toEqual(
      col(row(t("a"), t("b")), row(t("c"), t("d"))),
    );
    expect(reconcile(grid, ["a", "c"], BOX)).toEqual(col(t("a"), row(t("c"), t("slot:1"))));
    // Only slots left is no layout to keep.
    expect(reconcile(grid, ["x"], BOX)).toEqual(t("x"));
    expect(fill(grid, "slot:1", "a")).toEqual(col(t("b"), row(t("c"), t("a"))));
    expect(fill(grid, "a", "b")).toBe(grid);
    expect(fill(grid, "slot:9", "a")).toBe(grid);
    expect(closeSlot(grid, "slot:1")).toEqual(col(row(t("a"), t("b")), t("c")));
    // A slot is a place like any other for a drop beside it: the tile takes half of it.
    expect(leaves(dock(grid, "a", "slot:1", "left"))).toEqual(["b", "c", "a", "slot:1"]);
  });

  test("a stored layout reads back only when it is a sound tree", () => {
    const tree = col(row(t("a"), t("b")), t("c"));
    expect(readLayout(JSON.parse(JSON.stringify(tree)))).toEqual(tree);
    expect(readLayout({ dir: "row", kids: [t("a"), t("b")], sizes: "x" })).toEqual(
      row(t("a"), t("b")),
    );
    for (const bad of [
      null,
      "a",
      [],
      { id: "" },
      { dir: "diagonal", kids: [t("a"), t("b")] },
      { dir: "row", kids: [t("a")] },
      { dir: "row", kids: [t("a"), { id: 3 }] },
      row(t("a"), t("a")),
    ])
      expect(readLayout(bad)).toBeNull();
    let deep: unknown = t("z");
    for (let i = 0; i < 12; i++) deep = { dir: "row", kids: [t(`x${i}`), deep] };
    expect(readLayout(deep)).toBeNull();
  });

  test("a tile dropped near an edge goes beside, in the middle it takes the place", () => {
    expect(dropSide(10, 200, 400, 400)).toBe("left");
    expect(dropSide(390, 200, 400, 400)).toBe("right");
    expect(dropSide(200, 10, 400, 400)).toBe("top");
    expect(dropSide(200, 390, 400, 400)).toBe("bottom");
    expect(dropSide(200, 200, 400, 400)).toBe("center");
  });
});
