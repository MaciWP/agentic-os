import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { origin, removeTerminals, waitReady } from "./helpers.ts";

// The SPA under its Content-Security-Policy (server/static.ts): every route of the router
// renders without one violation. The routes are read from web/app.tsx, so a new page is
// visited without editing this file; a new path parameter fails here until it gets a value.
// The terminal route also opens the WebSocket and builds the voice AudioWorklet (blob:).
// Only one shell at repo:app is launched, and it is removed again.

const paths = [...readFileSync("web/app.tsx", "utf8").matchAll(/\bpath: "([^"]+)"/g)].map(
  ([, path]) => path as string,
);

declare global {
  interface Window {
    cspViolations: string[];
  }
}

async function violations(page: Page) {
  return page.evaluate(() => window.cspViolations);
}

test("every route renders under the CSP without a violation", async ({ page }) => {
  expect(paths.length).toBeGreaterThan(5);
  await page.addInitScript(() => {
    window.cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      window.cspViolations.push(
        `${e.effectiveDirective} ${e.blockedURI || "inline"} at ${e.sourceFile}:${e.lineNumber}`,
      );
    });
  });
  const res = await page.request.post("/api/terminals", {
    headers: { origin, "content-type": "application/json" },
    data: { harness: "shell", location: "app" },
  });
  expect(res.ok()).toBe(true);
  const { terminal } = (await res.json()) as { terminal: { id: string } };
  const params: Record<string, string> = { id: terminal.id, key: "CSP-1" };
  try {
    for (const path of paths) {
      const url = path.replaceAll(/\$(\w+)/g, (_, name: string) => {
        const value = params[name];
        if (!value) throw new Error(`csp.e2e.ts: give the route parameter $${name} a value`);
        return value;
      });
      const doc = await page.goto(url);
      // The policy is live on this server, not an older build without it.
      expect(doc?.headers()["content-security-policy"]).toContain("script-src 'self'");
      await expect(page.locator("#root > *").first()).toBeAttached();
      if (path === "/terminal/$id") {
        await expect(page.locator(".xterm-screen")).toBeVisible();
        await waitReady(page.locator("body"), terminal.id);
      }
      await page.waitForLoadState("load");
      expect([url, await violations(page)]).toEqual([url, []]);
    }

    // The listener does catch a violation: an inline script added to the page is refused.
    await page.evaluate(() => {
      const s = document.createElement("script");
      s.textContent = "window.cspRan = true";
      document.head.append(s);
    });
    await expect
      .poll(async () =>
        (await violations(page)).some((v) => v.startsWith("script-src-elem inline")),
      )
      .toBe(true);
    expect(await page.evaluate(() => "cspRan" in window)).toBe(false);
  } finally {
    await removeTerminals(page.request, [terminal.id]);
  }
});
