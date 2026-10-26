import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { throwawayParent } from "./fixture.ts";
import {
  currentMesa,
  noClippedControls,
  openTree,
  origin,
  removeTerminals,
  rowActions,
} from "./helpers.ts";

// Runs env commands, so only against a fake provider: the profile under test points envs.bin
// at AOS_E2E_ENVS_FIXTURE/envcli, a script under the system temp folder that lists the envs
// fake-a and fake-b; answers `shared status --json`, `proxy status --json` and
// `remove <env> --dry-run --json` (nothing to lose) with JSON; and for any other command
// prints "FAKE-ENV <args>", appends its args to calls.txt and waits while a file "hold" exists.
const FIXTURE = process.env.AOS_E2E_ENVS_FIXTURE;
const EVIDENCE = "data/evidence/w5";

type Terminal = { id: string; state: string; env: string | null; action?: string };
type Job = { id: string; state: string; output: string };

async function shoot(page: Page, name: string) {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await noClippedControls(page);
    for (const scheme of ["dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: `${EVIDENCE}/${name}-${width}-${scheme}.png` });
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
}

test.describe("env commands", () => {
  test.skip(!FIXTURE, "needs AOS_E2E_ENVS_FIXTURE and a profile whose envs.bin is its envcli");
  const dir = FIXTURE ?? "";
  const calls = join(dir, "calls.txt");
  const hold = join(dir, "hold");
  const called = () => (existsSync(calls) ? readFileSync(calls, "utf8") : "");
  const headers = { origin, "content-type": "application/json" };

  test.beforeAll(async ({ request }) => {
    throwawayParent(join(dir, "root"));
    rmSync(calls, { force: true });
    rmSync(hold, { force: true });
    // The provider must be the fake one before anything runs: its envs, then its sentinel
    // from the check-up. A profile pointing at a real provider stops the suite here.
    const p = (await (await request.get("/api/projects")).json()) as {
      envs: { items: { name: string }[]; error: string | null };
    };
    expect(p.envs.error).toBeNull();
    expect(p.envs.items.map((e) => e.name).sort(), "the fake provider's envs").toEqual([
      "fake-a",
      "fake-b",
    ]);
    const res = await request.post("/api/envs/jobs", { headers, data: { action: "doctor" } });
    expect(res.status()).toBe(201);
    const { job } = (await res.json()) as { job: Job };
    await expect
      .poll(
        async () =>
          ((await (await request.get(`/api/envs/jobs/${job.id}`)).json()) as { job: Job }).job
            .output,
      )
      .toContain("FAKE-ENV doctor");
  });

  test.afterAll(async ({ request }) => {
    rmSync(hold, { force: true });
    // The logs terminals this suite opened.
    const { terminals } = (await (await request.get("/api/terminals")).json()) as {
      terminals: Terminal[];
    };
    await removeTerminals(
      request,
      terminals.filter((x) => x.action).map((t) => t.id),
    );
  });

  test("an env's command runs without a terminal; its output opens as a tile", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/terminales?node=env:fake-a");
    await (await rowActions(page, "env:fake-a", "fake-a"))
      .getByRole("button", { name: "Levantar fake-a" })
      .click();

    // No terminal: the env's output tile.
    await expect.poll(async () => (await currentMesa(page))?.ids).toContain("job:fake-a");
    const tile = page.getByRole("region", { name: "Salida de fake-a" });
    const result = tile.getByLabel("Resultado: Arrancar fake-a");
    await expect(result).toContainText("FAKE-ENV start fake-a");
    await expect(result).toContainText("terminado");
    await shoot(page, "env");
    await expect(page.locator(".xterm-rows")).toHaveCount(0);
    expect(called()).toContain("start fake-a\n");
  });

  test("the logs, which never end, open a terminal", async ({ page }) => {
    await page.goto("/terminales?node=env:fake-a");
    await (await rowActions(page, "env:fake-a", "fake-a"))
      .getByRole("button", { name: "Logs fake-a" })
      .click();
    await expect.poll(async () => (await currentMesa(page))?.ids.length ?? 0).toBeGreaterThan(0);
    await expect(page.locator(".xterm-rows")).toContainText("FAKE-ENV logs fake-a --follow");
  });

  test("removing a clean env takes two steps: ¿Borrar? then a ticked last call", async ({
    page,
  }) => {
    await page.goto("/terminales?node=env:fake-b");
    await (await rowActions(page, "env:fake-b", "fake-b"))
      .getByRole("button", { name: "Borrar entorno…" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Borrar fake-b" });
    await expect(dialog).toContainText("Paso 1 de 2");
    await dialog.getByRole("button", { name: "Sí, continuar" }).click();
    const form = dialog.getByRole("form", { name: "Borrar entorno" });
    await expect(dialog).toContainText("Paso 2 de 2 · Último aviso");
    await expect(form).toContainText("No se pierde trabajo");
    const submit = form.getByRole("button", { name: "Borrar fake-b" });
    await expect(submit).toBeDisabled();
    await form.getByRole("checkbox", { name: "Sí, borrar fake-b" }).check();
    await expect(submit).toBeEnabled();
    await shoot(page, "remove");
    await submit.click();

    // The remove's output opens as a tile, and stays once the env is gone.
    await expect(dialog).toBeHidden();
    await expect(
      page
        .getByRole("region", { name: "Salida de fake-b" })
        .getByLabel("Resultado: Borrar entorno fake-b"),
    ).toContainText("FAKE-ENV remove fake-b --yes");
    expect(called()).toContain("remove fake-b --yes\n");
  });

  test("a new env from a ticket key shows the create's progress", async ({ page }) => {
    await page.goto("/terminales");
    const rail = await openTree(page);
    await rail.getByRole("button", { name: "Nuevo entorno", exact: true }).click();
    const pane = page.getByRole("dialog", { name: "Nuevo entorno" });
    const form = pane.getByRole("form", { name: "Nuevo entorno" });
    const create = form.getByRole("button", { name: "Crear entorno" });
    await expect(create).toBeDisabled();
    await form.getByRole("textbox", { name: "Ticket (rama feature/<clave>)" }).fill("abc-123");
    await expect(form.getByRole("textbox", { name: "Nombre" })).toHaveValue("abc-123");
    await form.getByRole("checkbox", { name: "frontend" }).uncheck();
    await create.click();

    await expect(pane.getByLabel("Resultado: Crear entorno abc-123")).toContainText(
      "FAKE-ENV create abc-123",
    );
    await shoot(page, "envs");
    expect(called()).toContain(
      "create abc-123 --repos backend --branch feature/ABC-123 --new --yes\n",
    );
  });

  test("the general status and the check-up show in the Diagnóstico modal", async ({ page }) => {
    await page.goto("/terminales");
    const rail = await openTree(page);
    await rail.getByRole("button", { name: "Diagnóstico", exact: true }).click();
    const pane = page.getByRole("dialog", { name: "Diagnóstico" });
    const status = pane.getByRole("region", { name: "Estado general" });
    await expect(status).toContainText("Servicios compartidos");
    await expect(status).toContainText("Proxy HTTPS");
    await expect(status).toContainText("fake-a");
    const check = pane.getByRole("region", { name: "Revisión" });
    await check.getByRole("button", { name: "Revisar" }).click();
    await expect(check.getByLabel("Resultado: Diagnóstico")).toContainText("FAKE-ENV doctor");
  });

  test("a second command on a busy env is refused, from the panel or a terminal", async ({
    page,
    request,
  }) => {
    writeFileSync(hold, "");
    await page.goto("/terminales?node=env:fake-a");
    const more = await rowActions(page, "env:fake-a", "fake-a");
    await more.getByRole("button", { name: "Actualizar fake-a" }).click();
    const pane = page.getByRole("region", { name: "Salida de fake-a" });
    await expect(pane.getByLabel("Resultado: Actualizar fake-a")).toContainText("en curso");
    // Busy: the row's command and the menu's wait.
    await expect(more.getByRole("button", { name: /^(Levantar|Parar) fake-a$/ })).toBeDisabled();
    await expect(more.getByRole("button", { name: "Borrar entorno…" })).toBeDisabled();

    const job = await request.post("/api/envs/jobs", {
      headers,
      data: { action: "stop", name: "fake-a" },
    });
    expect(job.status()).toBe(400);
    expect(((await job.json()) as { detail: string }).detail).toBe(
      "env fake-a is busy with update",
    );
    // A command opened in a terminal waits for the job too.
    const run = await request.post("/api/envs/run", {
      headers,
      data: { action: "start", name: "fake-a" },
    });
    expect(run.status()).toBe(400);
    expect(called()).not.toContain("stop fake-a\n");
    rmSync(hold, { force: true });
    await expect(pane.getByLabel("Resultado: Actualizar fake-a")).toContainText("terminado");
  });
});
