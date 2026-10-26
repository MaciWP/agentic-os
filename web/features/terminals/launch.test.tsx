import { describe, expect, test } from "bun:test";
import { HARNESS_CAPABILITIES, ModelSchema } from "../../../shared/harness-capabilities.ts";
import { renderWith } from "../../test-render.tsx";
import { currentLocation, defaultLocation, LAUNCH_PRESETS, LaunchAgent } from "./launch.tsx";

const env = (name: string, branch: string, problem: string | null = null) => ({
  name,
  branch,
  url: null,
  repos: [],
  dirs: problem ? [] : ["backend"],
  problem,
  locations: problem
    ? []
    : [
        { id: `env:${name}`, label: `${name} (entorno completo)` },
        { id: `env:${name}/backend`, label: `${name}/backend` },
      ],
});

const render = (envs: unknown) =>
  renderWith(<LaunchAgent ticketKey="ABC-9" />, [
    [["envs"], envs],
    [["terminals"], { terminals: [], locations: [{ id: "app", label: "app" }] }],
  ]);

describe("LaunchAgent", () => {
  test("picks the ticket's env by name, then by branch, never a broken one", () => {
    expect(defaultLocation([env("other", "X-1"), env("abc-9", "Y-2")], "ABC-9")).toBe("env:abc-9");
    expect(defaultLocation([env("feature", "ABC-9")], "ABC-9")).toBe("env:feature");
    expect(defaultLocation([env("abc-9", "ABC-9", "sin repos en disco")], "ABC-9")).toBe("new");
  });

  test("a picked env that disappears on refetch falls back to what the form can submit", () => {
    const others = [{ id: "app" }];
    const before = {
      configured: true as const,
      envs: [env("abc-9", "ABC-9"), env("other", "X-1")],
      repos: [],
    };
    expect(currentLocation("env:other/backend", before, others, "ABC-9")).toBe("env:other/backend");
    const after = {
      ...before,
      envs: [env("abc-9", "ABC-9"), env("other", "X-1", "sin repos en disco")],
    };
    expect(currentLocation("env:other/backend", after, others, "ABC-9")).toBe("env:abc-9");
    expect(currentLocation(null, after, others, "ABC-9")).toBe("env:abc-9");
    expect(currentLocation("app", after, others, "ABC-9")).toBe("app");
    const unconfigured = { configured: false as const, envs: [], repos: [] };
    expect(currentLocation("new", unconfigured, others, "ABC-9")).toBe("app");
  });

  test("with no env for the ticket it offers to create one on the ticket's branch", async () => {
    const html = await render({
      configured: true,
      envs: [env("other", "X-1")],
      repos: ["backend", "frontend"],
    });
    expect(html).toContain("Crear entorno nuevo…");
    expect(html).toContain("Repos (rama feature/ABC-9)");
    expect(html).toContain('value="abc-9"');
    expect(html).toContain(">Crear entorno</button>");
    expect(html).not.toContain(">Claude</button>");
  });

  test("an env with a problem is shown with it and offers nowhere to launch", async () => {
    const html = await render({
      configured: true,
      envs: [env("abc-9", "ABC-9", "sin repos en disco")],
      repos: ["backend"],
    });
    expect(html).toContain('label="abc-9: sin repos en disco"');
  });

  test("the model picker starts on each CLI's defaults and offers only what the server takes", async () => {
    const html = await render({ configured: false, envs: [], repos: [] });
    expect(html).toContain("Modelo y esfuerzo");
    expect(html).toMatch(/<option value="" selected="">Los de cada CLI<\/option>/);
    expect(html).toContain(">Sonnet · medium</option>");
    expect(html).not.toContain("Con un modelo elegido");
    expect(new Set(LAUNCH_PRESETS.map((p) => p.id)).size).toBe(LAUNCH_PRESETS.length);
    for (const p of LAUNCH_PRESETS) {
      expect(HARNESS_CAPABILITIES[p.harness].interactive).toContain(p.effort);
      if (p.model !== undefined) expect(ModelSchema.safeParse(p.model).success).toBe(true);
      // Codex and Grok model names change too often to hard-code: those keep their own.
      if (p.harness !== "claude") expect(p.model).toBeUndefined();
    }
  });

  test("without a provider it says so and launches in the app's own locations", async () => {
    const html = await render({ configured: false, envs: [], repos: [] });
    expect(html).toContain("No hay proveedor de entornos configurado");
    expect(html).not.toContain("Crear entorno nuevo…");
    expect(html).toContain(">Claude</button>");
  });
});
