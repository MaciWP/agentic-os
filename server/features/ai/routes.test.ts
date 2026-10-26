import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiEngine, type EngineConfig } from "./engine.ts";
import { aiRoutes } from "./routes.ts";

const dir = mkdtempSync(join(tmpdir(), "aos-ai-routes-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const cfg: EngineConfig = {
  bin: "/opt/llama/llama-server",
  model: "/models/q.gguf",
  port: 8090,
  contextTokens: 131072,
  reasoningBudget: -1,
  idleMinutes: 15,
};
const seen: string[] = [];
const engine = new AiEngine(cfg, {
  dataDir: dir,
  spawn: () => ({
    pid: 1,
    exited: new Promise(() => {}),
    stderr: new ReadableStream(),
    kill: () => {},
  }),
  fetch: async (url) => {
    seen.push(url);
    return url.endsWith("/health") ? new Response("{}") : Response.json({ ok: true });
  },
  sleep: async () => {},
  timer: () => () => {},
});
const app = aiRoutes(engine, null);
const post = (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("a hub without an engine says which machine has it", async () => {
  const hub = aiRoutes(null, "win");
  expect(await (await hub.request("/")).json()).toEqual({ configured: false, machine: "win" });
  expect((await hub.request("/start", { method: "POST" })).status).toBe(400);
});

test("game mode takes a boolean and is reported", async () => {
  expect((await post("/game-mode", { on: "yes" })).status).toBe(400);
  const res = await post("/game-mode", { on: true });
  expect(await res.json()).toMatchObject({ gameMode: true, state: "off" });
});

test("in game mode the Messages API answers in the API's error shape, not retried", async () => {
  const res = await post("/v1/messages?beta=true", { model: "local" });
  expect(res.status).toBe(403);
  const body = (await res.json()) as { type: string; error: { type: string; message: string } };
  expect(body.type).toBe("error");
  expect(body.error.message).toContain("modo juego");
  await post("/game-mode", { on: false });
});

test("the Messages API reaches the engine with its path and query", async () => {
  seen.length = 0;
  // The first health check finds the port free; the engine answers from then on.
  let free = true;
  const started = new AiEngine(cfg, {
    dataDir: mkdtempSync(join(dir, "s-")),
    spawn: () => ({
      pid: 2,
      exited: new Promise(() => {}),
      stderr: new ReadableStream(),
      kill: () => {},
    }),
    fetch: async (url) => {
      seen.push(url);
      if (url.endsWith("/health") && free) {
        free = false;
        throw new Error("refused");
      }
      return Response.json({ ok: true });
    },
    sleep: async () => {},
    timer: () => () => {},
  });
  const res = await aiRoutes(started, null).request("/v1/messages/count_tokens?beta=true", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(res.status).toBe(200);
  expect(seen.at(-1)).toBe("http://127.0.0.1:8090/v1/messages/count_tokens?beta=true");
});
