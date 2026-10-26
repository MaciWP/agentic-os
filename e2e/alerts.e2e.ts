import { expect, test } from "@playwright/test";
import { origin, removeTerminals } from "./helpers.ts";

// With another app in front, an alert also reaches the system's notifications, tagged with its
// key, and clicking it goes to the terminal. The browser's Notification is replaced by a
// recorder: the test checks what the app asks for, not what macOS shows.
const headers = { origin, "content-type": "application/json" };

type Shown = { title: string; body: string; tag: string; requireInteraction: boolean };

test("an alert while the app is behind another one reaches the system, and its click goes there", async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __shown: Shown[]; __click: () => void };
    w.__shown = [];
    class Recorder {
      static permission = "granted";
      static requestPermission = async () => "granted";
      onclick: (() => void) | null = null;
      constructor(title: string, opts: Omit<Shown, "title">) {
        w.__shown.push({
          title,
          body: opts.body,
          tag: opts.tag,
          requireInteraction: opts.requireInteraction,
        });
        w.__click = () => this.onclick?.();
      }
      close() {}
    }
    Object.defineProperty(window, "Notification", { value: Recorder });
    // Another app in front: the window has no focus.
    document.hasFocus = () => false;
  });
  const res = await request.post("/api/terminals", {
    headers,
    data: { harness: "shell", location: "app" },
  });
  expect(res.ok()).toBe(true);
  const id = ((await res.json()) as { terminal: { id: string } }).terminal.id;
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/terminales?ids=${id}`);
    await expect(page.locator(`section[data-terminal-id="${id}"]`)).toBeVisible();

    await request.post(`/api/terminals/${id}/stop`, { headers });
    await expect(page).toHaveTitle("(1) Agentic OS");
    const shown = () => page.evaluate(() => (window as never as { __shown: Shown[] }).__shown);
    await expect.poll(shown).toEqual([
      {
        title: expect.stringMatching(/^Shell · /),
        body: expect.stringMatching(/^ha terminado/),
        tag: `terminal:${id}`,
        requireInteraction: true,
      },
    ]);
    // «Siguiente» shows too, for when the user comes back.
    const next = page.getByRole("button", { name: /^Siguiente: Shell · .+, ha terminado/ });
    await expect(next).toBeVisible();

    await page.evaluate(() => (window as never as { __click: () => void }).__click());
    await expect(next).toHaveCount(0);
    await expect(page).toHaveTitle("Agentic OS");
  } finally {
    await removeTerminals(request, [id]);
  }
});
