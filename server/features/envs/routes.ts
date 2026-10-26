import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { type Context, Hono } from "hono";
import { CreateEnvRequest, RunEnvRequest } from "../../../shared/host-contract.ts";
import type { Deps } from "../../deps.ts";
import { errorMessage } from "../../error-message.ts";
import { LaunchError } from "../../launching.ts";
import type { TerminalInfo } from "../terminals/contract.ts";
import { heldTerminals, type Running } from "./actions.ts";
import { type EnvJobs, JobRequest } from "./jobs.ts";
import { envLocations, listEnvs, readProxy, removePreview, sharedStatus } from "./provider.ts";

// A launch the PTY host refused, in words, never as a 500.
async function launched(
  c: Context,
  start: () => Promise<TerminalInfo>,
  jobs: EnvJobs,
  next: Running,
) {
  const busy = jobs.blocker(next);
  if (busy) throw new LaunchError(busy);
  return c.json({ terminal: await start() }, 201);
}

// Each part of the status on its own: one failing read shows its error beside the others.
async function part<T>(read: () => Promise<T>) {
  try {
    return { value: await read(), error: null };
  } catch (err) {
    return { value: null, error: errorMessage(err) };
  }
}

export function envRoutes({ config, terminals }: Deps, jobs: EnvJobs) {
  return (
    new Hono()
      .get("/", async (c) => {
        const cfg = config.envs;
        if (!cfg) return c.json({ configured: false as const, envs: [], repos: [] });
        const envs = await listEnvs(cfg, await terminals.env);
        return c.json({
          configured: true as const,
          envs: envs.map((e) => ({ ...e, locations: envLocations(e) })),
          repos: cfg.repos,
        });
      })
      .post("/", async (c) => {
        const body = CreateEnvRequest.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
        const next = { action: "create", env: body.data.name } as const;
        return launched(c, () => terminals.createEnv(body.data), jobs, next);
      })
      // One of the provider's commands, in a visible terminal; the host checks it all again.
      .post("/run", async (c) => {
        const body = RunEnvRequest.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
        const next = { action: body.data.action, env: body.data.name ?? null };
        return launched(c, () => terminals.runEnv(body.data), jobs, next);
      })
      // The shared services and the proxy, each with its own error.
      .get("/status", async (c) => {
        const cfg = config.envs;
        if (!cfg) return c.json({ configured: false as const });
        const env = await terminals.env;
        const [shared, proxy] = await Promise.all([
          part(() => sharedStatus(cfg, env)),
          part(() => readProxy(cfg, env)),
        ]);
        return c.json({ configured: true as const, shared, proxy });
      })
      // What a remove would throw away, and the open terminals it would close; the provider's
      // dry run touches nothing.
      .get("/:name/remove-preview", async (c) => {
        const cfg = config.envs;
        if (!cfg) return c.json({ error: "disabled" }, 404);
        const name = c.req.param("name");
        const env = await terminals.env;
        if (!(await listEnvs(cfg, env)).some((e) => e.name === name))
          return c.json({ error: "not_found", detail: `env ${name} is not listed` }, 404);
        const preview = await removePreview(cfg, env, name);
        const dir = join(await realpath(cfg.root), name);
        const open = heldTerminals(await terminals.list(), dir, name);
        return c.json({ preview: { ...preview, open } });
      })
      .get("/jobs", (c) => c.json({ jobs: jobs.list() }))
      .get("/jobs/:id", (c) => {
        const job = jobs.get(c.req.param("id"));
        return job ? c.json({ job }) : c.json({ error: "not_found" }, 404);
      })
      // An env command run by the server itself, its output read back through /jobs/:id.
      .post("/jobs", async (c) => {
        const body = JobRequest.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
        return c.json({ job: await jobs.start(body.data) }, 201);
      })
  );
}
