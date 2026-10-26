import { type Context, Hono } from "hono";
import { z } from "zod";
import { errorMessage } from "../../error-message.ts";
import { type AiEngine, AiError } from "./engine.ts";

const GameModeBody = z.strictObject({ on: z.boolean() });

const NOT_HERE = {
  error: "ai_not_configured",
  detail: "esta máquina no ejecuta la IA local (ai.engine en config.json)",
} as const;

function failed(c: Context, err: unknown) {
  const code = err instanceof AiError ? err.code : "ai_unavailable";
  return c.json({ error: code, detail: errorMessage(err) }, code === "ai_game_mode" ? 409 : 503);
}

// The control routes for the system panel, and the one door Claude terminals use: the
// Anthropic Messages API, forwarded to the engine on loopback after starting it if needed.
// `machine`: on a hub, the worker that runs it, so the page knows where to ask.
export function aiRoutes(engine: AiEngine | null, machine: string | null) {
  return (
    new Hono()
      .get("/", (c) =>
        c.json(engine ? { configured: true, ...engine.state() } : { configured: false, machine }),
      )
      .post("/start", async (c) => {
        if (!engine) return c.json(NOT_HERE, 400);
        try {
          await engine.ensure();
          return c.json(engine.state());
        } catch (err) {
          return failed(c, err);
        }
      })
      .post("/stop", (c) => {
        if (!engine) return c.json(NOT_HERE, 400);
        engine.stop();
        return c.json(engine.state());
      })
      .post("/game-mode", async (c) => {
        const body = GameModeBody.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
        if (!engine) return c.json(NOT_HERE, 400);
        engine.setGameMode(body.data.on);
        return c.json(engine.state());
      })
      // Claude Code appends /v1/messages (and its query) to ANTHROPIC_BASE_URL. Errors come in
      // the API's own shape, so the terminal shows the reason. 403: the SDK retries 409 and
      // 5xx, and a retry cannot leave game mode or fix a failed start.
      .post("/v1/*", async (c) => {
        const url = new URL(c.req.url);
        const path = url.pathname.slice(url.pathname.indexOf("/v1/")) + url.search;
        try {
          if (!engine) throw new AiError("ai_unavailable", NOT_HERE.detail);
          return await engine.forward(path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: await c.req.arrayBuffer(),
            signal: c.req.raw.signal,
          });
        } catch (err) {
          return c.json(
            {
              type: "error",
              error: { type: "permission_error", message: `IA local: ${errorMessage(err)}` },
            },
            403,
          );
        }
      })
  );
}
