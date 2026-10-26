import { timingSafeEqual } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { z } from "zod";
import {
  CHANGED_FRAME,
  CreateEnvRequest,
  type Health,
  InputBody,
  LaunchSpec,
  Message,
  NameBody,
  PROTOCOL,
  RunEnvRequest,
  Size,
  WaitBody,
} from "../../shared/host-contract.ts";
import { COMMON_ERRORS } from "../common-errors.ts";
import { errorHandler } from "../errors.ts";
import type { ConsultationRunner } from "../features/coordination/runner.ts";
import {
  type Client,
  parseMessage,
  READ_LINES,
  socketClient,
} from "../features/terminals/contract.ts";
import type { TerminalManager } from "../features/terminals/pty.ts";

const EnvBody = z.object({ req: CreateEnvRequest, size: Size });
const RunEnvBody = z.object({ req: RunEnvRequest, size: Size });

export type HostHooks = {
  consultations?: ConsultationRunner;
  subscribeCoordination?: (listener: () => void) => void;
  // A server connected (true) or went away (false).
  control?: (connected: boolean) => void;
  // Asked to exit: when nothing is running, or forced by a full restart.
  shutdown?: () => void;
  // The build the starting server recorded, echoed on /health.
  build?: string;
};

const bearer = (token: string) => Buffer.from(`Bearer ${token}`);

export function createHostApp(terminals: TerminalManager, token: string, hooks: HostHooks = {}) {
  const expected = bearer(token);
  const running = () =>
    terminals.list().filter((t) => t.state === "running").length +
    (hooks.consultations?.running() ?? 0);
  // Every connected server hears when the list changes, so its browsers need not poll.
  const controls = new Set<ServerWebSocket>();
  terminals.subscribe(() => {
    for (const ws of controls) ws.send(CHANGED_FRAME);
  });
  hooks.subscribeCoordination?.(() => {
    for (const ws of controls) ws.send(CHANGED_FRAME);
  });

  return (
    new Hono()
      // Only the server talks to the host. A browser always sends Origin on a WebSocket and on
      // a POST, so refusing it keeps every web page out even before the token is checked.
      .use("*", async (c, next) => {
        if (c.req.header("origin") !== undefined) return c.json({ error: "forbidden_origin" }, 403);
        const got = Buffer.from(c.req.header("authorization") ?? "");
        if (got.length !== expected.length || !timingSafeEqual(got, expected))
          return c.json({ error: "unauthorized" }, 401);
        await next();
      })
      .get("/health", (c) =>
        c.json({
          protocol: PROTOCOL,
          build: hooks.build,
          pid: process.pid,
          running: running(),
        } satisfies Health),
      )
      .get("/terminals", (c) => c.json(terminals.list()))
      .post("/consultations/:id/start", async (c) => {
        if (!hooks.consultations) return c.json({ error: "consultations_unavailable" }, 503);
        await hooks.consultations.start(c.req.param("id"));
        return c.json({ accepted: true });
      })
      .post("/consultations/:id/cancel", async (c) => {
        if (!hooks.consultations) return c.json({ error: "consultations_unavailable" }, 503);
        await hooks.consultations.cancel(c.req.param("id"));
        return c.json({ accepted: true });
      })
      .get("/terminals/:id", (c) => {
        const info = terminals.get(c.req.param("id"));
        return info ? c.json(info) : c.json({ error: "not_found" }, 404);
      })
      .get("/launches/:id", (c) => c.json(terminals.launchStatus(c.req.param("id"))))
      .post("/terminals", async (c) => {
        const body = LaunchSpec.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
        return c.json(await terminals.create(body.data), 201);
      })
      .post("/envs", async (c) => {
        const body = EnvBody.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
        return c.json(await terminals.createEnv(body.data.req, body.data.size), 201);
      })
      .post("/envs/run", async (c) => {
        const body = RunEnvBody.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
        return c.json(await terminals.runEnv(body.data.req, body.data.size), 201);
      })
      .get("/terminals/:id/text", async (c) => {
        const lines = Number(c.req.query("lines") ?? READ_LINES);
        if (!Number.isInteger(lines) || lines < 1) return c.json({ error: "bad_request" }, 400);
        const text = await terminals.read(c.req.param("id"), lines);
        return text ? c.json(text) : c.json({ error: "not_found" }, 404);
      })
      .post("/terminals/:id/input", async (c) => {
        const body = InputBody.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
        const id = c.req.param("id");
        if (!terminals.get(id)) return c.json({ error: "not_found" }, 404);
        return c.json(terminals.write(id, body.data.data, { paste: body.data.paste }));
      })
      .post("/terminals/:id/wait", async (c) => {
        const body = WaitBody.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
        const result = await terminals.waitFor(c.req.param("id"), body.data);
        return result ? c.json(result) : c.json({ error: "not_found" }, 404);
      })
      .post("/terminals/:id/name", async (c) => {
        const body = NameBody.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
        return c.json(terminals.rename(c.req.param("id"), body.data.name));
      })
      .post("/terminals/:id/stop", (c) => c.json(terminals.stop(c.req.param("id"))))
      .post("/terminals/:id/resume", async (c) => {
        const info = await terminals.resume(c.req.param("id"));
        return info ? c.json(info) : c.json({ error: "not_found" }, 404);
      })
      .post("/terminals/:id/restart", async (c) => {
        const result = await terminals.restart(c.req.param("id"));
        return result ? c.json(result) : c.json({ error: "not_found" }, 404);
      })
      .delete("/terminals/:id", (c) => c.json(terminals.remove(c.req.param("id"))))
      .get("/pids", (c) => c.json([...terminals.pids()]))
      // `force` is a full restart: what runs is stopped and stays `running` in the DB, so the
      // next host resumes it, as after SIGTERM. A server replacing an idle host never forces.
      .post("/shutdown", (c) => {
        const n = running();
        if (n > 0 && c.req.query("force") !== "1")
          return c.json({ error: "busy", running: n }, 409);
        setTimeout(() => hooks.shutdown?.(), 0);
        return c.json({ shutdown: true });
      })
      .get(
        "/control",
        upgradeWebSocket(() => ({
          // A new context comes with every event; the raw socket is the same one.
          onOpen: (_event, ws) => {
            controls.add(ws.raw as ServerWebSocket);
            hooks.control?.(true);
          },
          onClose: (_event, ws) => {
            controls.delete(ws.raw as ServerWebSocket);
            hooks.control?.(false);
          },
        })),
      )
      // One socket per attached window; the server pipes it to the browser.
      .get(
        "/terminals/:id/ws",
        upgradeWebSocket((c) => {
          const id = c.req.param("id") ?? "";
          let client: Client | undefined;
          return {
            onOpen(_event, ws) {
              client = socketClient(ws.raw as ServerWebSocket);
              const take = c.req.query("take") === "1";
              if (!terminals.attach(id, client, take)) ws.close(4404, "not found");
            },
            onMessage(event) {
              const msg = parseMessage(Message, event.data);
              if (!client || !msg) return;
              if (msg.type === "input") terminals.input(id, client, msg.data);
              else terminals.resize(id, client, msg.cols, msg.rows);
            },
            onClose() {
              if (client) terminals.detach(id, client);
            },
          };
        }),
      )
      // Read back by host-client.ts. Anything else is a generic 500: its cause goes to the
      // host's log, never over the wire.
      .onError(errorHandler(COMMON_ERRORS, "host"))
  );
}
