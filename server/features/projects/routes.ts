import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { type Cached, cached } from "../../cache.ts";
import { APP_ROOT, type Config, onGithub } from "../../config.ts";
import type { Deps } from "../../deps.ts";
import { listLocations } from "../../launching.ts";
import { isInside, samePath } from "../../paths.ts";
import { ProviderError } from "../../provider-error.ts";
import {
  type Env,
  envLocations,
  listEnvs,
  type ProxyStatus,
  proxyStatus,
} from "../envs/provider.ts";
import type { TerminalInfo, Terminals } from "../terminals/contract.ts";
import { addWorktree, listBranches, removeWorktree, worktreeRoot } from "./native.ts";
import { addRepo, CONFIG_PATH, removable, removeRepo } from "./places.ts";
import { scanRepos } from "./worktrees.ts";

const AddBody = z.object({
  repo: z.string().min(1).max(100),
  branch: z.string().min(1).max(200),
  base: z.string().min(1).max(300).optional(),
});
const AddRepoBody = z.object({ path: z.string().min(1).max(1024) });
const RemoveBody = z.object({
  location: z.string().min(1).max(300),
  dropIgnored: z.boolean().optional(),
});

// The app's own node: the configured repo whose folder is the app's, so Agentic OS shows as a
// repo like any other; without one, the app's folder. The "app" location keeps launching.
export async function appNode(config: Config, root = APP_ROOT) {
  const real = await realpath(root).catch(() => root);
  for (const r of config.repos)
    if (samePath((await realpath(r.localPath).catch(() => null)) ?? "", real))
      return { location: `repo:${r.id}`, label: r.id };
  const [app] = listLocations(config);
  return { location: app?.id ?? "app", label: app?.label ?? "Agentic OS" };
}

type EnvSnapshot = { envs: Env[]; proxy: ProxyStatus | null };

// The env provider's list takes seconds, so the tree reads it once and again only when an
// env command ends or the user asks (`?fresh=1`). Launches never use this copy: they check
// the provider's list fresh.
export type EnvCache = Cached<EnvSnapshot>;

export function envCache(config: Config, terminals: Terminals): EnvCache {
  return cached(async () => {
    const cfg = config.envs;
    if (!cfg) return { envs: [], proxy: null };
    const env = await terminals.env;
    const [envs, proxy] = await Promise.all([listEnvs(cfg, env), proxyStatus(cfg, env)]);
    return { envs, proxy };
  });
}

// An env command that ended may have changed the env list. The tree is told only once the
// list is read again: told at once, it would wait seconds on the provider's cold list, while
// this way it keeps showing the old one until the new one is in. A failed read is told too.
export async function reloadEnvs(cache: EnvCache, publish: () => void) {
  cache.invalidate();
  await cache.get().catch(() => {});
  publish();
}

// Called on every change of the terminal list. A terminal that ended may have changed the
// projects: an env command (start, create) changes the env list, and a shell may have added
// a worktree. Only then the tree is told to read again.
export function watchEnded(terminals: Terminals, cache: EnvCache, publish: () => void) {
  const ended = new Set<string>();
  return async () => {
    let list: TerminalInfo[];
    try {
      list = await terminals.list();
    } catch {
      return;
    }
    const ids = new Set(list.map((t) => t.id));
    for (const id of ended) if (!ids.has(id)) ended.delete(id);
    const fresh = list.filter((t) => t.state !== "running" && !ended.has(t.id));
    if (fresh.length === 0) return;
    for (const t of fresh) ended.add(t.id);
    if (fresh.some((t) => t.harness === "env")) return reloadEnvs(cache, publish);
    publish();
  };
}

// A proxy host belongs to an env when its first label is the env's name, alone or as the
// last part (`<prefix>-<env>`).
const hostOf = (name: string) => (host: string) => {
  const label = host.split(".")[0] ?? "";
  return label === name || label.endsWith(`-${name}`);
};

// A host the provider printed reaches an href only when it is a plain host[:port].
const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/i;

// The web a checkout serves: the proxy host a config rule names for its repo, as an https
// URL. Null without a rule, or with no such host up.
export const checkoutLink = (
  links: { repo: string; prefix: string }[],
  hosts: string[],
  env: string,
  repo: string | null,
) => {
  const rule = links.find((l) => l.repo === repo);
  const host =
    rule && hosts.find((h) => HOST.test(h) && h.split(".")[0] === `${rule.prefix}${env}`);
  return host ? `https://${host}` : null;
};

// The tree, plus the app's own worktrees: add and remove run git and then `onChange` tells
// the open views. Refusals and git errors reach the app's onError.
export function projectRoutes(
  { config, terminals, configPath = CONFIG_PATH }: Deps,
  cache: EnvCache,
  onChange: () => void,
) {
  // What the tree shows of a repo's config: its section, its GitHub name, whether it can leave.
  const configured = (id: string) => {
    const r = config.repos.find((x) => x.id === id);
    return {
      group: r?.group ?? null,
      github: r && onGithub(r) ? `${r.owner}/${r.name}` : null,
      removable: Boolean(r && removable(r)),
    };
  };
  // A provider failure stays on the envs group; the repos still show.
  const loadEnvs = async (fresh: boolean) => {
    const none = { envs: [] as Env[], proxy: null as ProxyStatus | null, root: "", error: null };
    const cfg = config.envs;
    if (!cfg) return { configured: false, ...none };
    const root = await realpath(cfg.root).catch(() => null);
    if (!root) return { configured: true, ...none, error: `${cfg.root} does not exist` };
    try {
      if (fresh) cache.invalidate();
      const { envs, proxy } = await cache.get();
      return { configured: true, ...none, envs, proxy, root };
    } catch (err) {
      if (err instanceof ProviderError) return { configured: true, ...none, error: err.message };
      throw err;
    }
  };

  return new Hono()
    .get("/", async (c) => {
      const env = await terminals.env;
      const [envs, scan, wt] = await Promise.all([
        loadEnvs(c.req.query("fresh") === "1"),
        scanRepos(config, env),
        worktreeRoot(config),
      ]);
      const root = wt.root;
      const items = envs.envs.map((e) => {
        const hosts = envs.proxy?.hosts.filter(hostOf(e.name)) ?? [];
        return {
          ...e,
          locations: envLocations(e),
          // Which repo and branch each directory is, read from git, not from its name.
          checkouts: e.problem
            ? []
            : e.dirs.map((dir) => {
                const known = scan.envCheckouts.get(join(envs.root, e.name, dir));
                return {
                  dir,
                  location: `env:${e.name}/${dir}`,
                  repo: known?.repo ?? null,
                  branch: known?.branch ?? null,
                  link: checkoutLink(config.envs?.links ?? [], hosts, e.name, known?.repo ?? null),
                };
              }),
          hosts,
        };
      });
      const app = await appNode(config);
      return c.json({
        envs: {
          configured: envs.configured,
          items,
          proxy: envs.proxy,
          error: envs.error,
          // What "Nuevo entorno" offers to check out.
          repos: config.envs?.repos ?? [],
        },
        repos: scan.repos.map((r) => ({
          ...r,
          location: `repo:${r.id}`,
          ...configured(r.id),
          // Only what the app made: Orca's and the user's own worktrees have no Quitar.
          worktrees: r.worktrees.map((w) => ({
            ...w,
            removable: Boolean(root && w.location && w.path !== root && isInside(root, w.path)),
          })),
        })),
        worktrees: { configured: Boolean(config.worktrees), error: wt.error },
        app,
        colors: config.projectColors,
      });
    })
    .post("/repos", async (c) => {
      const body = AddRepoBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
      const repo = await addRepo(config, await terminals.env, body.data.path, configPath);
      onChange();
      return c.json({ id: repo.id, location: `repo:${repo.id}` });
    })
    .delete("/repos/:id", async (c) => {
      await removeRepo(config, terminals, c.req.param("id"), configPath);
      onChange();
      return c.json({ ok: true });
    })
    .get("/repos/:id/branches", async (c) =>
      c.json(await listBranches(config, await terminals.env, c.req.param("id"))),
    )
    .post("/worktrees", async (c) => {
      const body = AddBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
      const result = await addWorktree(config, await terminals.env, body.data);
      onChange();
      return c.json(result);
    })
    .delete("/worktrees", async (c) => {
      const body = RemoveBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
      const result = await removeWorktree(config, terminals, body.data);
      onChange();
      return c.json(result);
    });
}
