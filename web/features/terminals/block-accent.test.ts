import { expect, test } from "bun:test";
import { accentOf } from "./block-accent.ts";
import type { Workspace } from "./mesas.ts";

const workspace = (block?: string): Workspace => ({
  version: 1,
  activeId: "m2",
  mesas: [
    { id: "m1", name: "Mesa 1", ids: [], layout: null, block: "b1" },
    { id: "m2", name: "Mesa 2", ids: [], layout: null, ...(block && { block }) },
  ],
  blocks: [
    { id: "b1", name: "Producto", color: "green" },
    { id: "b2", name: "Herramientas", color: "rose" },
  ],
});

test("the accent is the active Mesa's block colour; none without a block or a known one", () => {
  expect(accentOf(workspace("b2"))).toBe("rose");
  expect(accentOf(workspace())).toBeNull();
  expect(accentOf(workspace("gone"))).toBeNull();
  expect(accentOf({ ...workspace("b2"), blocks: undefined })).toBeNull();
});
