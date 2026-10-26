import { describe, expect, test } from "bun:test";
import { failQuery, renderWith } from "../../test-render.tsx";
import { memoryStorage } from "../../test-storage.ts";
import { pr, ticket } from "../home/test-fixtures.ts";
import { RailSources, railSource } from "./rail-sources.tsx";
import { projects } from "./test-fixtures.ts";

const seeds = (): [unknown[], unknown][] => [
  [["projects"], projects()],
  [["terminals"], { terminals: [], locations: [] }],
  [["tickets"], { jql: "q", tickets: [ticket("ABC-1", "new"), ticket("ABC-2", "new")] }],
  [["tickets", "team"], { jql: "q", tickets: [], me: "me" }],
  [
    ["prs"],
    {
      // Only the configured repos count: «elsewhere» is not one of them.
      prs: [
        { ...pr(7, "review"), repo: "alpha" },
        { ...pr(8, "mine"), repo: "elsewhere" },
      ],
      errors: [],
      repos: [],
    },
  ],
];

const tabs = (html: string) => html.slice(html.indexOf('aria-label="Fuentes del carril"'));

describe("RailSources", () => {
  test("opens on the projects tree; Tickets and PRs say how many they hold", async () => {
    const disk = memoryStorage("local", {});
    try {
      const html = await renderWith(<RailSources />, seeds());
      expect(tabs(html)).toMatch(/aria-pressed="true"[^>]*>Proyectos<\/button>/);
      expect(tabs(html)).toMatch(/>Tickets<span[^>]*>2<\/span><\/button>/);
      expect(tabs(html)).toMatch(/>PRs<span[^>]*>1<\/span><\/button>/);
      expect(html).toContain('aria-label="Otros proyectos"');
      expect(html).not.toContain("ABC-2");
    } finally {
      disk.restore();
    }
  });

  test("shows the kept tab; a node link shows the projects whatever was kept", async () => {
    const disk = memoryStorage("local", { "aos.rail.source": "prs" });
    try {
      const prs = await renderWith(<RailSources />, seeds());
      expect(tabs(prs)).toMatch(/aria-pressed="true"[^>]*>PRs/);
      expect(prs).toContain("alpha#7");
      expect(prs).not.toContain("elsewhere#8");
      railSource.set("tickets");
      const tickets = await renderWith(<RailSources />, seeds());
      expect(tickets).toContain("ABC-2");
      const linked = await renderWith(<RailSources node="repo:alpha" />, seeds());
      expect(tabs(linked)).toMatch(/aria-pressed="true"[^>]*>Proyectos/);
    } finally {
      disk.restore();
    }
  });

  test("an unknown kept tab falls back to the projects", () => {
    const disk = memoryStorage("local", { "aos.rail.source": "mesas" });
    try {
      expect(railSource.get()).toBe("projects");
    } finally {
      disk.restore();
    }
  });

  // Rule 3: a failed read is an error, never an empty tab nor a zero.
  test("a failed tickets read says so in its tab and shows no count", async () => {
    const disk = memoryStorage("local", { "aos.rail.source": "tickets" });
    try {
      const html = await renderWith(
        <RailSources />,
        seeds().filter(([k]) => k[0] !== "tickets"),
        failQuery(["tickets"], undefined, "Jira 503"),
      );
      expect(tabs(html)).toMatch(/>Tickets<\/button>/);
      expect(html).toContain("Jira 503");
    } finally {
      disk.restore();
    }
  });
});
