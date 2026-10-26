import { expect, test } from "@playwright/test";
import { origin } from "./helpers.ts";

// The local model's engine as the isolated server runs it (scripts/e2e-isolated.ts): a fake
// llama-server started and stopped from the system panel, refused in game mode, and the one
// door Claude terminals use. Only meant for the isolated server: on 4317 it is the PC's engine.

const ENGINE = "http://127.0.0.1:4328/health";
const answers = () =>
  fetch(ENGINE).then(
    (r) => r.ok,
    () => false,
  );

test("the system panel starts, gates and stops the local engine; the door forwards", async ({
  page,
}) => {
  test.skip(!origin.includes(":4318"), "drives a fake engine only the isolated server has");
  const post = (path: string, data: unknown = {}) =>
    page.request.post(path, { headers: { origin, "content-type": "application/json" }, data });
  await post("/api/ai/game-mode", { on: false });
  await post("/api/ai/stop");

  await page.goto("/");
  await page.getByRole("button", { name: "Consumo del sistema" }).click();
  const panel = page.getByRole("dialog");
  const motor = panel.locator("section", { hasText: "IA local" });
  await expect(motor).toContainText("Apagado");
  await expect(motor).toContainText("Se apaga tras 1 min sin uso.");

  await motor.getByRole("button", { name: "Encender" }).click();
  await expect(motor).toContainText("Listo", { timeout: 15_000 });
  expect(await answers()).toBe(true);

  // What a Claude terminal sends reaches the engine with its path and query.
  const door = await post("/api/ai/v1/messages?beta=true", { model: "local", messages: [] });
  expect(door.status()).toBe(200);
  expect(await door.json()).toEqual({
    path: "/v1/messages?beta=true",
    body: { model: "local", messages: [] },
  });

  // Game mode stops it and refuses the door with a reason the terminal can show.
  await motor.getByRole("checkbox", { name: "Modo juego" }).click();
  await expect(motor).toContainText("Modo juego: no arranca");
  await expect(motor.getByRole("button", { name: "Encender" })).toBeDisabled();
  await expect.poll(answers).toBe(false);
  const refused = await post("/api/ai/v1/messages", { model: "local", messages: [] });
  expect(refused.status()).toBe(403);
  expect((await refused.json()).error.type).toBe("permission_error");

  await motor.getByRole("checkbox", { name: "Modo juego" }).click();
  await expect(motor).toContainText("Apagado");
  await motor.getByRole("button", { name: "Encender" }).click();
  await expect(motor).toContainText("Listo", { timeout: 15_000 });
  await motor.getByRole("button", { name: "Apagar" }).click();
  await expect(motor).toContainText("Apagado");
  await expect.poll(answers).toBe(false);
});
