import { expect, test } from "bun:test";
import { Hono } from "hono";
import { readyGate } from "./ready.ts";

test("answers 503 until the app is ready, then the app, then 503 again once quiesced", async () => {
  const gate = readyGate();
  const req = () => new Request("http://localhost:4317/api/health");
  const before = await gate.fetch(req());
  expect(before.status).toBe(503);
  expect(await before.text()).toBe("Starting");
  gate.serve(new Hono().get("/api/health", (c) => c.json({ ok: true })));
  const ready = await gate.fetch(req());
  expect(ready.status).toBe(200);
  expect(await ready.json()).toEqual({ ok: true });
  gate.quiesce();
  expect((await gate.fetch(req())).status).toBe(503);
});
