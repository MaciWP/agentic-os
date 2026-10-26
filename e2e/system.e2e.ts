import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { origin, removeTerminals } from "./helpers.ts";

const run = promisify(execFile);

// The top bar's system indicator and the sleep guard: a running shell shows in the indicator
// and its panel, and the server holds a caffeinate exactly while the shell runs. Only meant
// for the isolated server (scripts/e2e-isolated.ts), whose PTY host starts with no terminals.

// The pid listening on the server's port, then the caffeinate processes it started.
async function serverCaffeinates(): Promise<string[]> {
  const port = new URL(origin).port;
  const { stdout: pid } = await run("/usr/sbin/lsof", [
    "-nP",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-t",
  ]);
  const { stdout } = await run("/bin/ps", ["-A", "-o", "ppid=,command="]);
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith(`${pid.trim()} `) && l.includes("caffeinate"));
}

test("a running shell shows in the indicator and keeps the Mac awake until it stops", async ({
  page,
}) => {
  const api = (path: string, method = "POST", data: unknown = {}) =>
    page.request.fetch(path, {
      method,
      headers: { origin, "content-type": "application/json" },
      data,
    });
  // Other specs may run terminals at the same time; the guard follows them too, so the check
  // is the rule itself: one caffeinate while any terminal runs, none otherwise.
  const running = async () =>
    (
      (await (await page.request.get("/api/terminals")).json()) as {
        terminals: { state: string }[];
      }
    ).terminals.filter((t) => t.state === "running").length;
  const followsRule = async () =>
    (await serverCaffeinates()).length === ((await running()) > 0 ? 1 : 0);
  await expect.poll(followsRule).toBe(true);
  const { terminal } = (await (
    await api("/api/terminals", "POST", { harness: "shell", location: "app" })
  ).json()) as { terminal: { id: string } };
  try {
    await expect
      .poll(serverCaffeinates)
      .toEqual([expect.stringMatching(/caffeinate -i -s -w \d+$/)]);

    await page.goto("/");
    const indicator = page.getByRole("button", { name: "Consumo del sistema" });
    const line = indicator.locator("[title]").first();
    await expect(line).toHaveAttribute("title", /^[1-9]\d* term\. en marcha · .+ % CPU · /);
    await expect(line).toHaveAttribute(
      "title",
      /Claude (\d+ %|renovada|sin dato).* · Codex (\d+ %|renovada|sin dato).* · Grok sin dato/,
    );

    await indicator.click();
    const panel = page.getByRole("dialog");
    await expect(panel).toContainText(/Terminales en marcha \(\d+\)/);
    // A process scan is reused for 4 s and the panel polls every 5 s: a shell started just
    // after another page warmed the scan shows its use up to about 9 s later.
    await expect(panel.getByRole("button", { name: /Shell/ }).last()).toContainText(/% CPU/, {
      timeout: 15_000,
    });
    await expect(panel).toContainText("PTY host");
    await expect(panel.getByText("PTY host").locator("..")).not.toContainText("no encontrado");
    await expect(panel).toContainText("Suscripción de Codex");
    await expect(panel).toContainText("El Mac no se dormirá");
  } finally {
    await removeTerminals(page.request, [terminal.id]);
  }
  await expect.poll(followsRule).toBe(true);
});

test("«No bloquear la pantalla» holds the display for its time and «Quitar» frees it", async ({
  page,
}) => {
  const free = () =>
    page.request.post("/api/system/awake", {
      headers: { origin, "content-type": "application/json" },
      data: { screen: null },
    });
  const screen = async () =>
    (
      (await (await page.request.get("/api/system")).json()) as {
        awake: { screen: { until: string | null; auto: boolean } | null };
      }
    ).awake.screen;
  const holdsDisplay = async () =>
    (await serverCaffeinates()).some((l) => /caffeinate -d -i -s -w \d+$/.test(l));
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.getByRole("button", { name: "Consumo del sistema" }).click();
    const panel = page.getByRole("dialog");
    await expect(panel).toContainText("La pantalla se bloquea sola");

    await panel.getByRole("button", { name: "1 h", exact: true }).click();
    await expect(panel).toContainText(/Activo hasta las \d{2}:\d{2}\./);
    const held = await screen();
    expect(held?.auto).toBe(false);
    const left = Date.parse(held?.until ?? "") - Date.now();
    expect(left).toBeGreaterThan(55 * 60_000);
    expect(left).toBeLessThanOrEqual(60 * 60_000);
    await expect.poll(holdsDisplay).toBe(true);
    await expect(page.locator('[title="La pantalla no se bloquea"]')).toBeVisible();
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: "data/evidence/system/screen-held-1280-dark.png" });

    await panel.getByRole("button", { name: "Quitar", exact: true }).click();
    await expect(panel).toContainText("La pantalla se bloquea sola");
    expect(await screen()).toBeNull();
    await expect.poll(holdsDisplay).toBe(false);
  } finally {
    await free();
  }
});

// The isolated server runs without scripts/supervise.ts: a restart would leave nobody to start
// it again, so the server refuses it before touching anything, and the dialog says why.
test("«Reiniciar todo» without the supervisor is refused and nothing stops", async ({ page }) => {
  const before = ((await (await page.request.get("/api/health")).json()) as { pid: number }).pid;
  await page.goto("/");
  await page.getByRole("button", { name: "Consumo del sistema" }).click();
  await page.getByRole("button", { name: "Reiniciar…" }).click();
  const dialog = page.getByRole("dialog", { name: "Reiniciar Agentic OS" });
  await dialog.getByRole("button", { name: "Reiniciar todo" }).click();
  await expect(dialog).toContainText(
    "No se reinicia: el servidor no corre bajo el supervisor: nadie lo volvería a arrancar",
  );
  await expect(dialog.getByRole("button", { name: "Reiniciar todo" })).toBeEnabled();
  const after = ((await (await page.request.get("/api/health")).json()) as { pid: number }).pid;
  expect(after).toBe(before);
});
