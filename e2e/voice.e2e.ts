import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { origin, removeTerminals, waitReady } from "./helpers.ts";

// Dictation end to end: Chromium's fake microphone plays a synthetic Spanish phrase (macOS
// `say`, no one's real voice, looped by Chromium), ⌃⌘ held in the tile records it, the local
// model transcribes it whole at the release and the text lands at the shell's prompt without
// being run. Esc drops a hold, short or long.
test.use({
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${resolve("e2e/fixtures/voz.wav")}`,
    ],
  },
});

// A shell open in its own window, or as a Mesa tile inside the app, ready to dictate into;
// stopped and removed at the end.
async function withShell(
  page: Page,
  where: "window" | "mesa",
  run: (shell: {
    rows: ReturnType<Page["locator"]>;
    screen: () => Promise<string>;
  }) => Promise<void>,
) {
  const voice = (await (await page.request.get("/api/voice")).json()) as { configured: boolean };
  test.skip(!voice.configured, "voice.model is not in config.json");
  // The first dictation may load the model (a few seconds) before it transcribes.
  test.setTimeout(120_000);

  const api = (path: string, method = "POST", data: unknown = {}) =>
    page.request.fetch(path, {
      method,
      headers: { origin, "content-type": "application/json" },
      data,
    });
  const res = await api("/api/terminals", "POST", { harness: "shell", location: "app" });
  expect(res.ok(), await res.text()).toBe(true);
  const { terminal } = (await res.json()) as { terminal: { id: string } };
  const screen = async () =>
    (
      (await (await page.request.get(`/api/terminals/${terminal.id}/text`)).json()) as {
        text: string;
      }
    ).text;
  try {
    await page.goto(
      where === "window" ? `/terminal/${terminal.id}` : `/terminales?ids=${terminal.id}`,
    );
    await expect(page.getByText("en marcha").first()).toBeVisible();
    const rows = page.locator(".xterm-rows");
    await waitReady(page.locator("body"), terminal.id);
    await expect(page.getByRole("button", { name: "Dictar" })).toBeEnabled();
    // A click, as a hand focuses the tile: the page may then start audio.
    await page.locator(".xterm-screen").click();
    await run({ rows, screen });
  } finally {
    await removeTerminals(page.request, [terminal.id]);
  }
}

test("holding ⌃⌘ dictates into the terminal without pressing Enter", async ({ page }) => {
  await withShell(page, "window", async ({ rows, screen }) => {
    const sent: number[] = [];
    page.on("request", (r) => {
      if (r.url().endsWith("/api/voice/transcribe")) sent.push(Date.now());
    });
    const hold = async (ms: number, end: () => Promise<void>) => {
      await page.keyboard.down("Control");
      await page.keyboard.down("Meta");
      await expect(page.getByRole("button", { name: "Parar el dictado" })).toBeVisible();
      await page.waitForTimeout(ms);
      await end();
      // The release starts with the first key up, and the app sends then: a time taken after
      // both keys are up came 3 ms after the request it was meant to precede.
      const releasing = Date.now();
      await page.keyboard.up("Meta");
      await page.keyboard.up("Control");
      return releasing;
    };
    const said = async () => ((await screen()).match(/hola/gi) ?? []).length;

    // The phrase lasts 3.9 s; a longer hold hears it whole at least once.
    await page.keyboard.down("Control");
    await page.keyboard.down("Meta");
    await expect(page.getByRole("button", { name: "Parar el dictado" })).toBeVisible();
    // Over the terminal, not only in the header.
    await expect(page.getByRole("status").filter({ hasText: "Escuchando" })).toBeVisible();
    await page.waitForTimeout(4500);
    await page.keyboard.up("Meta");
    await page.keyboard.up("Control");

    await expect(rows).toContainText(/hola mundo/i, { timeout: 30_000 });
    // Each dictation ends before the next can start.
    await expect(page.getByRole("button", { name: "Dictar" })).toBeVisible({ timeout: 15_000 });
    expect(await screen()).toMatch(/hola mundo/i);
    // Pasted, not run: no shell answered the line.
    expect(await screen()).not.toMatch(/command not found|not found/i);

    // One request per dictation, sent at the release, however long the hold.
    expect(sent).toHaveLength(1);
    sent.length = 0;
    const before = await said();
    const released = await hold(9000, async () => {
      expect(sent).toEqual([]);
    });
    await expect.poll(said, { timeout: 30_000 }).toBeGreaterThanOrEqual(before + 2);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeGreaterThanOrEqual(released);
    expect(await screen()).not.toMatch(/command not found|not found/i);
    await expect(page.getByRole("button", { name: "Dictar" })).toBeVisible({ timeout: 15_000 });

    // Esc after a long hold drops all of it.
    let screenBefore = await screen();
    await hold(5000, () => page.keyboard.press("Escape"));
    await expect(page.getByRole("button", { name: "Dictar" })).toBeVisible();
    await page.waitForTimeout(2000);
    expect(sent).toHaveLength(1);
    expect(await screen()).toBe(screenBefore);

    // Esc during a short hold sends nothing at all.
    screenBefore = await screen();
    sent.length = 0;
    await hold(500, () => page.keyboard.press("Escape"));
    await expect(page.getByRole("button", { name: "Dictar" })).toBeVisible();
    await page.waitForTimeout(1000);
    expect(sent).toEqual([]);
    expect(await screen()).toBe(screenBefore);
  });
});

// The text of a released dictation reaches its terminal after its tile is gone (the Mesa left
// for Inicio), and the tile shown again meanwhile shows the wait.
test("leaving the terminal while it transcribes keeps the text", async ({ page }) => {
  await withShell(page, "mesa", async ({ rows, screen }) => {
    // The transcription leaves only once the view is gone, so it cannot win the race.
    let release = () => {};
    const away = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/voice/transcribe", async (route) => {
      await away;
      await route.continue();
    });
    const home = page
      .getByRole("navigation", { name: "Principal" })
      .getByRole("link", { name: "Inicio" });

    await page.keyboard.down("Control");
    await page.keyboard.down("Meta");
    await expect(page.getByRole("button", { name: "Parar el dictado" })).toBeVisible();
    await page.waitForTimeout(4500);
    await page.keyboard.up("Meta");
    await page.keyboard.up("Control");
    const waiting = page.getByRole("status").filter({ hasText: "Transcribiendo" });
    await expect(waiting).toBeVisible();

    // In-app moves, never a reload: a reload drops the request itself.
    await home.click();
    await expect(rows).toHaveCount(0);
    await page.goBack();
    await expect(waiting).toBeVisible();
    await home.click();
    await expect(rows).toHaveCount(0);
    release();

    await expect.poll(screen, { timeout: 30_000 }).toMatch(/hola mundo/i);
    expect(await screen()).not.toMatch(/command not found|not found/i);
    await page.goBack();
    await expect(rows).toContainText(/hola mundo/i, { timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Dictar" })).toBeVisible();
  });
});
