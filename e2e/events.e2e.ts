import { expect, type Page, test } from "@playwright/test";
import { origin } from "./helpers.ts";

// The dashboard is not polled: the server pushes which list changed. Terminals are
// started and stopped through the API, not the panel, so only a pushed event can update
// it. A plain shell is the only thing launched, and it is removed again.

async function shell(page: Page) {
  const api = (path: string, method = "POST", data: unknown = {}) =>
    page.request.fetch(path, {
      method,
      headers: { origin, "content-type": "application/json" },
      data,
    });
  const res = await api("/api/terminals", "POST", { harness: "shell", location: "app" });
  expect(res.ok()).toBe(true);
  const { terminal } = (await res.json()) as { terminal: { id: string } };
  return {
    stop: () => api(`/api/terminals/${terminal.id}/stop`),
    remove: () => api(`/api/terminals/${terminal.id}`, "DELETE"),
  };
}

const items = (page: Page) =>
  page.getByRole("list", { name: /^Terminales en / }).getByRole("listitem");
const running = (page: Page) => page.getByRole("button", { name: /^Parar Shell en / });

// Requests the page makes after the first load, the held event stream aside.
function countRequests(page: Page) {
  const seen: string[] = [];
  page.on("request", (r) => {
    if (!r.url().endsWith("/api/events")) seen.push(`${r.method()} ${r.url()}`);
  });
  return seen;
}

// "networkidle" never comes while the stream is held, so wait for the stream itself.
async function settled(page: Page) {
  const stream = page.waitForResponse((r) => r.url().endsWith("/api/events"));
  await page.goto("/");
  await expect(page.getByText("Ninguna terminal todavía.").or(items(page).first())).toBeVisible();
  await stream;
  await page.waitForTimeout(1000);
}

test("a terminal started, stopped and removed elsewhere shows within a second", async ({
  page,
}) => {
  await settled(page);
  const before = await items(page).count();
  const runningBefore = await running(page).count();
  const t = await shell(page);
  await expect(items(page)).toHaveCount(before + 1, { timeout: 1000 });
  await expect(running(page)).toHaveCount(runningBefore + 1, { timeout: 1000 });
  await t.stop();
  await expect(running(page)).toHaveCount(runningBefore, { timeout: 3000 });
  await t.remove();
  await expect(items(page)).toHaveCount(before, { timeout: 1000 });
});

test("an idle dashboard makes no requests, and its stream outlives the server's idle timeout", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await settled(page);
  const seen = countRequests(page);
  await page.waitForTimeout(25_000);
  expect(seen).toEqual([]);
  const before = await items(page).count();
  const t = await shell(page);
  await expect(items(page)).toHaveCount(before + 1, { timeout: 1000 });
  await t.stop();
  await expect.poll(async () => (await t.remove()).ok(), { timeout: 5000 }).toBe(true);
});

test("a stream refused once is opened again by the page", async ({ page }) => {
  let refused = 0;
  await page.route("**/api/events", (route) => {
    if (refused++ === 0) return route.fulfill({ status: 503, body: "restarting" });
    return route.continue();
  });
  await settled(page);
  await expect.poll(() => refused).toBeGreaterThan(1);
  const before = await items(page).count();
  const t = await shell(page);
  await expect(items(page)).toHaveCount(before + 1, { timeout: 3000 });
  await t.stop();
  await expect.poll(async () => (await t.remove()).ok(), { timeout: 5000 }).toBe(true);
});
