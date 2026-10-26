import { describe, expect, test } from "bun:test";
import { projectColor } from "../../../shared/project-colors.ts";
import { renderWith } from "../../test-render.tsx";
import { ProjectTag } from "./project-tag.tsx";
import { projects } from "./test-fixtures.ts";

describe("ProjectTag", () => {
  test("takes the configured colour, else the name's", async () => {
    const seeded = { ...projects(), colors: { alpha: "orange" as const } };
    const set = await renderWith(<ProjectTag name="alpha" />, [[["projects"], seeded]]);
    expect(set).toMatch(/^<span data-project-color="orange" class="project-tag /);
    expect(set).toContain(">alpha</span>");
    // Before the list loads, or for a project left out, the name picks it.
    const picked = await renderWith(<ProjectTag name="beta" />, [[["projects"], seeded]]);
    expect(picked).toContain(`data-project-color="${projectColor("beta")}"`);
    const unread = await renderWith(<ProjectTag name="alpha" />, []);
    expect(unread).toContain(`data-project-color="${projectColor("alpha")}"`);
  });
});
