import { describe, expect, test } from "bun:test";
import { renderWith } from "../../test-render.tsx";
import { JobView } from "./job-tile.tsx";
import { job, projects, summary, withJob } from "./test-fixtures.ts";

const render = (env: string | null, data: [unknown[], unknown][]) =>
  renderWith(<JobView env={env} />, [[["projects"], projects()], ...data]);

describe("JobView", () => {
  test("shows the env's newest job, running, with what the provider wrote so far", async () => {
    const running = summary({ id: "j2", action: "start", state: "running", endedAt: null });
    const html = await render("env-a", [
      [["envjobs"], { jobs: [running, summary(), summary({ id: "j3", env: "env-b" })] }],
      withJob(job({ ...running, output: "starting backend" })),
    ]);
    expect(html).toContain(">Entorno</span>");
    expect(html).toContain('data-harness="env"');
    expect(html).toContain('aria-label="Resultado: Arrancar env-a"');
    expect(html).toContain("en curso");
    expect(html).toContain("starting backend");
    // The output fills the tile instead of a short box.
    expect(html).not.toContain("max-h-72");
    expect(html).not.toContain("ya no está");
  });

  test("a failed job says why", async () => {
    const failed = summary({ state: "failed", error: "exit 2" });
    const html = await render("env-a", [[["envjobs"], { jobs: [failed] }], withJob(job(failed))]);
    expect(html).toContain("falló: exit 2");
  });

  test("with no job since the server started it says so, never an empty box", async () => {
    const html = await render("env-a", [[["envjobs"], { jobs: [summary({ env: "env-b" })] }]]);
    expect(html).toContain("No hay ninguna acción de env-a desde que arrancó el servidor");
    expect(html).not.toContain("Resultado:");
  });

  test("while the jobs load it claims nothing", async () => {
    const html = await render("env-a", []);
    expect(html).not.toContain("No hay ninguna acción");
    expect(html).not.toContain("Resultado:");
  });

  test("a removed env keeps its remove's result in sight and says it is gone", async () => {
    const removed = summary({ id: "r1", action: "remove", env: "env-old" });
    const html = await render("env-old", [
      [["envjobs"], { jobs: [removed] }],
      withJob(job({ ...removed, output: "removed env-old" })),
    ]);
    expect(html).toContain("ya no está");
    expect(html).toContain('aria-label="Resultado: Borrar entorno env-old"');
    expect(html).toContain("removed env-old");
  });

  test("a failed env provider never calls the env gone", async () => {
    const html = await render("env-a", [
      [["projects"], projects({ items: [], error: "envctl timed out" })],
      [["envjobs"], { jobs: [summary()] }],
    ]);
    expect(html).not.toContain("ya no está");
  });

  test("a tile id that names no env says how to get one", async () => {
    const html = await render(null, [[["envjobs"], { jobs: [] }]]);
    expect(html).toContain("no dice de qué entorno es");
  });
});
