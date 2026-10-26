import { expect, test } from "@playwright/test";
import {
  noClippedControls,
  openTree,
  origin,
  railOf,
  removeTerminals,
  resetWorkspace,
  waitReady,
} from "./helpers.ts";

// A terminal that needs the user: one chime, «Siguiente» in the top bar, a blinking ring and a
// chip on its tile, its tree row and the tab's title say so until the user looks at it. Only a shell at repo:frontend is launched, and
// it is removed again. The Entornos header's buttons open their modals without running anything.
const EVIDENCE = "data/evidence/attention";
const headers = { origin, "content-type": "application/json" };

// The Mesa's counts and tiles are the test's: one empty Mesa first, whatever an earlier file left.
test.beforeEach(async ({ request }) => resetWorkspace(request));

test("a shell that ends while the user looks elsewhere chimes, shows «Siguiente», blinks and counts", async ({
  page,
  request,
}) => {
  // Counts the chime's notes: the page's audio is real, its output is not checked.
  await page.addInitScript(() => {
    const w = window as unknown as { __notes: number };
    w.__notes = 0;
    const make = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function (this: AudioContext) {
      w.__notes += 1;
      return make.call(this);
    };
  });
  const res = await request.post("/api/terminals", {
    headers,
    data: { harness: "shell", location: "repo:frontend" },
  });
  expect(res.ok()).toBe(true);
  const id = ((await res.json()) as { terminal: { id: string } }).terminal.id;
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/terminales?ids=${id}`);
    const tile = page.locator(`section[data-terminal-id="${id}"]`);
    await expect(tile).toBeVisible();
    await expect(page).toHaveTitle("Agentic OS");
    const rail = railOf(page);
    // The browser keeps audio locked until a click: the speaker says so, then wakes. The focus
    // then sits outside the tile.
    await expect(
      page.getByRole("button", { name: "Sonido bloqueado: haz clic en la app" }),
    ).toBeVisible();
    await page.getByRole("heading", { name: "Mesa", exact: true }).click();
    await expect(page.getByRole("button", { name: "Sonido de los avisos" })).toBeVisible();

    await request.post(`/api/terminals/${id}/stop`, { headers });
    await expect(page).toHaveTitle("(1) Agentic OS");
    await expect(tile.locator('[data-part="attention"]')).toBeVisible();
    await expect(page.getByRole("link", { name: "Mesa" })).toHaveAttribute(
      "title",
      "Mesa · 1 te necesita",
    );
    // Its Mesa's card says why it waits.
    await expect(
      rail.getByRole("tab", { name: /^Mesa 1\s*(Ha terminado|Ha fallado)$/ }),
    ).toBeVisible();
    // Nothing covers the page: «Siguiente» in the top bar names it, the tile says why it waits.
    const next = page.getByRole("button", { name: /^Siguiente: Shell · .+, ha terminado/ });
    await expect(next).toBeVisible();
    await expect(page.getByRole("region", { name: "Avisos" })).toHaveCount(0);
    // A clean exit is done ("turn", falling notes); one by a signal or an error code, "failed"
    // (low notes). Three notes each.
    const { terminals } = (await (await request.get("/api/terminals")).json()) as {
      terminals: { id: string; exitCode: number | null }[];
    };
    const clean = terminals.find((t) => t.id === id)?.exitCode === 0;
    await expect(tile.locator('[data-part="wait"]')).toHaveAttribute(
      "data-wait",
      clean ? "turn" : "failed",
    );
    await expect
      .poll(() => page.evaluate(() => (window as never as { __notes: number }).__notes))
      .toBe(3);
    for (const scheme of ["dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: `${EVIDENCE}/waiting-1280-${scheme}.png` });
    }
    // The ring pulses three times (6 s), then stays lit and still: no frame every vsync.
    const ring = tile.locator('[data-part="attention"]');
    await expect(ring).toHaveCSS("animation-name", "attention");
    await expect
      .poll(() => ring.evaluate((el) => el.getAnimations().length), { timeout: 9_000 })
      .toBe(0);
    await expect(ring).toBeVisible();

    // A reload, as «Reiniciar todo» does, keeps what waits, and does not chime it again.
    await page.reload();
    await expect(next).toBeVisible();
    await expect(page).toHaveTitle("(1) Agentic OS");
    await expect(tile.locator('[data-part="attention"]')).toBeVisible();
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as never as { __notes: number }).__notes)).toBe(0);

    await next.click();
    await expect(next).toHaveCount(0);
    await expect(page).toHaveTitle("Agentic OS");
    await expect(tile.locator('[data-part="attention"]')).toHaveCount(0);
    await expect(tile.locator('[data-part="wait"]')).toHaveCount(0);
  } finally {
    await removeTerminals(request, [id]);
  }
});

test("the Entornos header opens «Nuevo entorno» in a modal that Esc closes", async ({ page }) => {
  const data = (await (await page.request.get("/api/projects")).json()) as {
    envs: { configured: boolean };
  };
  test.skip(!data.envs.configured, "needs an env provider in the profile");
  // Desktop only: below md the Mesa has no rails (web/features/terminals/grid.tsx, "below md
  // there are no rails"), so the tree and its Entornos header are not on a phone.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/terminales");
  const rail = await openTree(page);
  const open = rail.getByRole("button", { name: "Nuevo entorno", exact: true });
  await expect(open).toBeVisible();
  await expect(rail.getByRole("button", { name: "Diagnóstico", exact: true })).toBeVisible();
  await noClippedControls(page);

  await open.click();
  const dialog = page.getByRole("dialog", { name: "Nuevo entorno" });
  await expect(dialog.getByRole("button", { name: "Crear entorno" })).toBeDisabled();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: `${EVIDENCE}/new-env-1280-dark.png` });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();
});

test("⌘⇧. from inside a terminal opens the one that waits, and the shell never gets the key", async ({
  page,
  request,
}) => {
  const make = async () => {
    const res = await request.post("/api/terminals", {
      headers,
      data: { harness: "shell", location: "app" },
    });
    expect(res.ok()).toBe(true);
    return ((await res.json()) as { terminal: { id: string } }).terminal.id;
  };
  const [a, b] = [await make(), await make()];
  const ids = [a, b];
  const typing = page.locator(`section[data-terminal-id="${a}"]`);
  const waiting = page.locator(`section[data-terminal-id="${b}"]`);
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/terminales?ids=${ids.join(",")}`);
    await waitReady(typing, a);
    await waitReady(waiting, b);
    await typing.locator(".xterm-screen").click();
    await page.keyboard.type("echo marca");

    await request.post(`/api/terminals/${b}/stop`, { headers });
    const next = page.getByRole("button", { name: /^Siguiente: Shell · .+, ha terminado/ });
    await expect(next).toBeVisible();
    await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Shift+Period`);
    await expect(next).toHaveCount(0);
    await expect(waiting.locator('[data-part="attention"]')).toHaveCount(0);
    await expect(typing.locator(".xterm-rows")).toContainText("echo marca");
    await expect(typing.locator(".xterm-rows")).not.toContainText(/echo marca[>:.]/);
  } finally {
    await removeTerminals(request, ids);
  }
});
