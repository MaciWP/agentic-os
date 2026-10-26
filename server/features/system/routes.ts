import { type Context, Hono } from "hono";
import { z } from "zod";
import type { Deps } from "../../deps.ts";
import type { ProcRow } from "../monitor/monitor.ts";
import { logsText } from "./logs.ts";
import { type Plans, systemSnapshot } from "./system.ts";
import { installPending, paired } from "./update.ts";

// The screen kept on for 1, 2 or 4 hours, or until switched off (null); `screen: null` frees it.
export const AwakeBody = z.object({
  screen: z
    .object({ minutes: z.union([z.literal(60), z.literal(120), z.literal(240)]).nullable() })
    .nullable(),
});

export const LogsQuery = z.object({
  lines: z.coerce.number().int().min(1).max(2000).default(200),
});

export const RestartBody = z.object({ scope: z.enum(["server", "all"]) });

// The hub's code for a worker: its version and the gzipped tar, base64 inside JSON so the
// request passes local-guard like any other write.
export const UpdateBody = z.object({
  version: z.string().regex(/^[0-9a-f]{16}$/),
  bundle: z.string().min(1),
});

const refuse = (c: Context, detail: string) => c.json({ error: "update_refused", detail }, 409);

export function systemRoutes(
  { terminals, hostInfo, keepAwake, restart, update, logs = [] }: Deps,
  ps?: () => Promise<ProcRow[]>,
  plans?: () => Promise<Plans>,
) {
  return (
    new Hono()
      .get("/", async (c) =>
        c.json(await systemSnapshot({ terminals, hostInfo, keepAwake, ps, plans })),
      )
      // Plain text, to read with curl from another machine as well as in a browser.
      .get("/logs", async (c) => {
        const query = LogsQuery.safeParse({ lines: c.req.query("lines") });
        if (!query.success)
          return c.json({ error: "bad_request", detail: query.error.issues }, 400);
        return c.text(await logsText(logs, query.data.lines));
      })
      .post("/awake", async (c) => {
        const body = AwakeBody.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
        if (!keepAwake) return c.json({ error: "unavailable" }, 409);
        const { screen } = body.data;
        if (screen) keepAwake.hold(screen.minutes);
        else keepAwake.release();
        return c.json({ awake: keepAwake.state() });
      })
      .post("/restart", async (c) => {
        // Allowed remotely on purpose: it is how a device away from the Mac loads new code. The
        // 202 comes before the stop; the page then waits for a server with another pid.
        const body = RestartBody.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
        if (!restart)
          return c.json(
            { error: "restart_refused", detail: "este servidor no puede reiniciarse" },
            409,
          );
        const refused = await restart.start(body.data.scope);
        if (refused) return c.json({ error: "restart_refused", detail: refused }, 409);
        return c.json({ restarting: body.data.scope, pid: process.pid }, 202);
      })
      .post("/update", async (c) => {
        // It runs new code, so a Tailscale login is not enough: only the paired hub's token.
        if (!update) return refuse(c, "este servidor no se actualiza desde el hub");
        if (!paired(update.dataDir, c.req.header("authorization")))
          return c.json(
            { error: "unpaired", detail: "falta el token de esta máquina o no es el emparejado" },
            401,
          );
        const body = UpdateBody.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
        const unsupervised = restart ? await restart.unsupervised() : "no tiene supervisor";
        if (!restart || unsupervised) return refuse(c, unsupervised ?? "no tiene supervisor");
        const { version } = body.data;
        const refused = await update.apply(Buffer.from(body.data.bundle, "base64"), version);
        if (refused) return refuse(c, refused);
        // New packages are installed between the stop and the start, with the PTY host gone.
        const scope = installPending(update.dataDir) ? "all" : "server";
        const late = await restart.start(scope);
        if (late) return refuse(c, `código ${version} copiado, pero no se reinicia: ${late}`);
        return c.json({ restarting: scope, pid: process.pid, version }, 202);
      })
  );
}
