import { expect, test } from "@playwright/test";
import {
  addMesa,
  getWorkspace,
  mesaMenu,
  noClippedControls,
  origin,
  removeTerminals,
  waitReady,
  workspaceIntent,
} from "./helpers.ts";

const headers = { origin, "content-type": "application/json" };
test("two devices share mesa membership, retain their views, and require explicit terminal takeover", async ({
  browser,
  request,
}) => {
  const terminalIds: string[] = [];
  const desktop = await browser.newContext({
    baseURL: origin,
    viewport: { width: 1440, height: 900 },
  });
  const mobile = await browser.newContext({
    baseURL: origin,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const left = await desktop.newPage();
  const right = await mobile.newPage();
  const mesaId = crypto.randomUUID();
  try {
    for (let i = 0; i < 2; i++) {
      const result = await request.post("/api/terminals", {
        headers,
        data: { harness: "shell", location: "app", requestId: crypto.randomUUID() },
      });
      expect(result.ok()).toBe(true);
      terminalIds.push((await result.json()).terminal.id);
    }
    const name = `Shared ${mesaId.slice(0, 6)}`;
    await addMesa(request, { id: mesaId, name, ids: terminalIds });
    await left.goto(`/terminales?mesa=${mesaId}`);
    await expect(left.locator("[data-terminal-id]")).toHaveCount(2);
    await waitReady(left.locator("[data-terminal-id]").first());
    await right.goto(`/terminales?mesa=${mesaId}`);
    await expect(right.getByRole("combobox", { name: "Mesa activa" })).toHaveValue(mesaId);
    await expect(right.locator("[data-terminal-id]")).toHaveCount(1);
    await expect(right.getByRole("button", { name: "Traer aquí", exact: true })).toBeVisible();
    await right.getByRole("button", { name: "Traer aquí", exact: true }).click();
    await expect(right.getByRole("button", { name: "Ctrl+C", exact: true })).toBeEnabled();
    await expect(left.getByRole("button", { name: "Traer aquí", exact: true })).toBeVisible();
    await noClippedControls(right);
    await right.getByRole("combobox", { name: "Panel visible" }).selectOption(terminalIds[1] ?? "");
    await expect(right.locator(`[data-terminal-id="${terminalIds[1]}"]`)).toBeVisible();
    await expect(left.locator("[data-terminal-id]")).toHaveCount(2);
    // A rename from a third client reaches both devices.
    await workspaceIntent(request, { kind: "rename", mesa: mesaId, name: `${name} updated` });
    await expect(left.getByRole("tab", { name: `${name} updated`, exact: true })).toBeVisible();
    await expect(
      right.getByRole("combobox", { name: "Mesa activa" }).locator("option:checked"),
    ).toHaveText(`${name} updated`);
    await right.screenshot({
      path: "data/evidence/architecture-implementation/mobile-mesa.png",
      fullPage: true,
    });
  } finally {
    await desktop.close();
    await mobile.close();
    await removeTerminals(request, terminalIds);
  }
});

test("a committed mesa command with a lost response retries the same ID", async ({
  page,
  request,
}) => {
  const mesaId = crypto.randomUUID();
  await addMesa(request, { id: mesaId, name: "Lost response", ids: [] });
  await page.goto(`/terminales?mesa=${mesaId}`);
  await expect(page.getByRole("tab", { name: "Lost response", exact: true })).toBeVisible();
  const requests: string[] = [];
  await page.route("**/api/workspace/commands", async (route) => {
    requests.push(route.request().postDataJSON().requestId);
    const response = await route.fetch();
    if (requests.length === 1) await route.abort("failed");
    else await route.fulfill({ response });
  });
  await (await mesaMenu(page)).getByRole("menuitem", { name: /^Renombrar/ }).click();
  await page.getByRole("textbox", { name: "Nombre de la Mesa" }).fill("Recovered response");
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("No se ha confirmado el cambio");
  const committed = await getWorkspace(request);
  await page.getByRole("alert").getByRole("button", { name: "Reintentar", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(requests).toHaveLength(2);
  expect(requests[0]).toBe(requests[1]);
  expect((await getWorkspace(request)).revision).toBe(committed.revision);
});

test("mobile agent draft survives a lost response and reload without launching an agent", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const response = await request.post("/api/terminals", {
    headers,
    data: { harness: "shell", location: "app" },
  });
  const id = (await response.json()).terminal.id as string;
  const posts: { requestId: string; text: string }[] = [];
  // A shell provides the real websocket. Only the display classification and message
  // endpoint are fixtures: this test must never start or address a real model.
  await page.route("**/api/terminals", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      response,
      json: {
        ...data,
        terminals: data.terminals.map((t: { id: string }) =>
          t.id === id ? { ...t, harness: "claude" } : t,
        ),
      },
    });
  });
  await page.route("**/api/coordination/messages", async (route) => {
    const input = route.request().postDataJSON();
    posts.push(input);
    if (posts.length === 1) await route.abort("failed");
    else
      await route.fulfill({
        status: 202,
        json: {
          ...input,
          id: "message-fixture",
          from: "user",
          threadId: "message-fixture",
          createdAt: new Date().toISOString(),
          status: "delivered",
          error: null,
        },
      });
  });
  try {
    await page.goto(`/terminales?t=${id}`);
    await expect(page.getByRole("button", { name: "Ctrl+C", exact: true })).toBeEnabled();
    // The dock types into the terminal; a coordination message is its other mode.
    await page.getByRole("button", { name: "Mensaje", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Mensaje al agente" })
      .fill("Borrador móvil con varias líneas\nSegunda línea");
    await page.getByRole("button", { name: "Enviar mensaje", exact: true }).click();
    await expect(page.getByRole("button", { name: "Comprobar / reintentar envío" })).toBeEnabled();
    await page.reload();
    await page.getByRole("button", { name: "Mensaje", exact: true }).click();
    const draft = page.getByRole("textbox", { name: "Mensaje al agente" });
    await expect(draft).toHaveValue("Borrador móvil con varias líneas\nSegunda línea");
    await expect(draft).toHaveAttribute("readonly", "");
    await expect(page.getByRole("button", { name: "Comprobar / reintentar envío" })).toBeEnabled();
    await page.getByRole("button", { name: "Comprobar / reintentar envío" }).click();
    await expect(draft).toHaveValue("");
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
    await noClippedControls(page);
  } finally {
    await removeTerminals(request, [id]);
  }
});
