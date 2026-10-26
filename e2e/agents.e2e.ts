import { expect, type Page, test } from "@playwright/test";
import { currentMesa, noClippedControls, origin, removeTerminals } from "./helpers.ts";

// The agent monitor: a shell that prints for 8 s shows working, then waiting; a hidden page
// reads no snapshot; the row's actions reach the grid, the workspace and the terminal. One
// shell at repo:contract, found by its id, so the grid suite's shells there never match.
const EVIDENCE = "data/evidence/w7";
const headers = { origin, "content-type": "application/json" };

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

// Hidden or shown as the browser would say it; TanStack listens on the window.
const setVisible = (page: Page, visible: boolean) =>
  page.evaluate((v) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (v ? "visible" : "hidden"),
    });
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
  }, visible);

test.describe("agent monitor", () => {
  test.describe.configure({ mode: "serial" });
  let id = "";
  // A card's links add its own id last, after the ids already in the grid.
  const row = (page: Page) => page.locator("li", { has: page.locator(`a[href*="${id}&node="]`) });

  test.beforeAll(async ({ request }) => {
    const res = await request.post("/api/terminals", {
      headers,
      data: { harness: "shell", location: "repo:contract" },
    });
    expect(res.ok()).toBe(true);
    id = ((await res.json()) as { terminal: { id: string } }).terminal.id;
  });

  test.afterAll(async ({ request }) => {
    const { terminals } = (await (await request.get("/api/terminals")).json()) as {
      terminals: { id: string }[];
    };
    if (!terminals.some((t) => t.id === id)) return;
    await removeTerminals(request, [id]);
  });

  test("a shell printing for 8 s shows working, then waiting, with its usage and last line", async ({
    page,
    request,
  }) => {
    // Under load each `sleep` fork can take a second, so the 8 s loop may take far longer.
    test.setTimeout(120_000);
    await page.goto("/agentes");
    await expect(page.getByRole("heading", { name: "Agentes" })).toBeVisible();
    // A login shell can take seconds to start under load, and it may drop keys typed before
    // its prompt; the row says "en espera" from the start, so wait for the prompt itself.
    await expect
      .poll(
        async () =>
          (
            (await (await request.get(`/api/terminals/${id}/text`)).json()) as { text: string }
          ).text.trim().length,
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
    await expect(row(page)).toContainText("en espera", { timeout: 10_000 });
    await expect(row(page)).toContainText("% CPU");

    const sent = await request.post(`/api/terminals/${id}/send`, {
      headers,
      data: { text: "for i in $(seq 40); do echo tick$i; sleep 0.2; done", enter: true },
    });
    expect(sent.ok()).toBe(true);
    await expect(row(page)).toContainText("trabajando", { timeout: 10_000 });
    await expect(row(page)).toContainText(/tick\d+/, { timeout: 10_000 });
    await expect(page.getByText(/^[1-9]\d* trabajando · /)).toBeVisible();
    await shoot(page, "working");
    // The loop has ended; from here the row must settle within the window plus the dwell.
    await expect
      .poll(
        async () =>
          (
            (await (await request.get(`/api/terminals/${id}/text`)).json()) as { text: string }
          ).text.includes("tick40"),
        { timeout: 60_000 },
      )
      .toBe(true);
    await expect(row(page)).toContainText("en espera", { timeout: 20_000 });
    await expect(row(page)).toContainText("última salida");
  });

  test("a hidden page reads no snapshot until it shows again", async ({ page }) => {
    const reads: number[] = [];
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/api/agents") reads.push(Date.now());
    });
    await page.goto("/agentes");
    await expect.poll(() => reads.length, { timeout: 8000 }).toBeGreaterThan(1);
    await setVisible(page, false);
    const hidden = reads.length;
    // Two intervals and a half.
    await page.waitForTimeout(12_500);
    expect(reads.length).toBe(hidden);
    await setVisible(page, true);
    await expect.poll(() => reads.length, { timeout: 6000 }).toBeGreaterThan(hidden);
  });

  test("Cuadrícula and Ver reach the grid and its node in the Mesa; Parar then Quitar end it", async ({
    page,
    request,
  }) => {
    await page.goto("/agentes");
    await expect(row(page)).toBeVisible();
    await row(page)
      .getByRole("button", { name: /^Llevar a la cuadrícula / })
      .click();
    await expect.poll(async () => (await currentMesa(page))?.ids).toContain(id);
    await expect(page.locator("section[aria-label^='Shell en ']")).toHaveCount(1);

    await page.goto("/agentes");
    await row(page).getByRole("link", { name: /^Ver / }).click();
    await expect.poll(async () => (await currentMesa(page))?.ids).toContain(id);
    await expect.poll(async () => (await currentMesa(page))?.node).toBe("repo:contract");

    await page.goto("/agentes?h=shell");
    await expect(page.getByRole("combobox", { name: "Harness" })).toHaveValue("shell");
    await shoot(page, "filtered");
    // The lanes carry the same row and keep the filter; back to the board drops `v`.
    await page.getByRole("button", { name: "Carriles" }).click();
    await expect(page).toHaveURL(/v=carriles/);
    await expect(page).toHaveURL(/h=shell/);
    await expect(page.getByRole("button", { name: "Carriles" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(row(page)).toContainText("en espera");
    await shoot(page, "lanes");
    await page.getByRole("button", { name: "Por estado" }).click();
    await expect(page).not.toHaveURL(/v=carriles/);
    await expect(row(page)).toBeVisible();
    await row(page)
      .getByRole("button", { name: /^Parar / })
      .click();
    await expect(row(page)).toContainText("terminada", { timeout: 8000 });
    await expect(row(page)).not.toContainText("en espera");
    await row(page)
      .getByRole("button", { name: /^Quitar / })
      .click();
    await expect(row(page)).toHaveCount(0);
    const { terminals } = (await (await request.get("/api/terminals")).json()) as {
      terminals: { id: string }[];
    };
    expect(terminals.some((t) => t.id === id)).toBe(false);
  });
});
