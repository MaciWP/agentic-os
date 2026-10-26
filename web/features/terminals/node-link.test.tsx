import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderWith } from "../../test-render.tsx";
import { NodeLink } from "./node-link.tsx";
import { type Mesa, MesaContext } from "./place.ts";

const inMesa = (node: ReactNode, mesa: Partial<Mesa> = {}) => (
  <MesaContext.Provider value={{ ids: [], open: () => {}, openTile: () => {}, ...mesa }}>
    {node}
  </MesaContext.Provider>
);

describe("NodeLink", () => {
  test("in the Mesa a terminal link carries its intent and keeps the marked node", async () => {
    const html = await renderWith(
      inMesa(
        <NodeLink node="wt:alpha:fix" t="a1">
          Abrir
        </NodeLink>,
        { ids: ["x"], max: "x", node: "repo:alpha" },
      ),
    );
    expect(html).toContain('href="/terminales?mesa=mesa-1&amp;t=a1&amp;node=repo%3Aalpha"');
  });

  test("outside the Mesa it goes there with the last grid and marks its node", async () => {
    const html = await renderWith(
      <NodeLink node="repo:alpha" t="a1">
        Abrir
      </NodeLink>,
    );
    expect(html).toContain('href="/terminales?mesa=mesa-1&amp;t=a1&amp;node=repo%3Aalpha"');
  });
});
