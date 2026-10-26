import { expect, test } from "@playwright/test";

test("the shell loads real connection states from the server", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Agentic OS" })).toBeVisible();
  const connections = page.getByRole("list", { name: "Conexiones" });
  // Jira is the only connection the server lists (a disabled provider is not listed).
  await expect(connections.getByText("Jira", { exact: true })).toBeVisible();
});
