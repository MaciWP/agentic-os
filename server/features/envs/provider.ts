import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { BRANCH, ENV_NAME, ISSUE_KEY, ticketBranch } from "../../../shared/envs.ts";
import type { CreateEnvRequest } from "../../../shared/host-contract.ts";
import type { EnvsConfig, HostConfig } from "../../config-host.ts";
import { errorMessage } from "../../error-message.ts";
import { LaunchError, type Location } from "../../launching.ts";
import { ProviderError } from "../../provider-error.ts";
import { type RunResult, run } from "../../run.ts";

// A generic env provider: a CLI with `list --json` and an interactive `create`. Its binary,
// root and repo names live in data/config.json, never in the code.

const DIR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
export const LIST_TIMEOUT_MS = 20_000;
// A remove preview runs `git status` over every repo and submodule: 17 s on a cold env.
export const PREVIEW_TIMEOUT_MS = 60_000;

const Listed = z.array(
  z.looseObject({
    env: z.string(),
    branch: z.string().nullish(),
    url: z.string().nullish(),
    repos: z
      .array(
        z.looseObject({
          repo: z.string(),
          branch: z.string().nullish(),
          docker: z.string().nullish(),
          servers: z.string().nullish(),
        }),
      )
      .default([]),
  }),
);

export type Env = {
  name: string;
  branch: string | null;
  url: string | null;
  // As the CLI names its repos, with its own one-line status of Docker and dev servers.
  repos: { repo: string; branch: string | null; docker: string | null; servers: string | null }[];
  // Directories under <root>/<name> that are git checkouts.
  dirs: string[];
  // Why this env cannot be launched in, shown instead of silently dropping it.
  problem: string | null;
};

// Every failure here names the provider: a missing binary or a changed output format is the
// provider's problem, never a 500 or an empty list.
export async function runJson(
  cfg: EnvsConfig,
  env: Record<string, string>,
  args: string[],
  timeout = LIST_TIMEOUT_MS,
) {
  const what = args[0];
  let res: RunResult;
  try {
    res = await run([cfg.bin, ...args], { env, timeoutMs: timeout });
  } catch (err) {
    throw new ProviderError("envs", 502, `cannot run ${cfg.bin}: ${errorMessage(err)}`);
  }
  if (res.timedOut) throw new ProviderError("envs", 504, `${what} timed out after ${timeout} ms`);
  if (res.truncated) throw new ProviderError("envs", 502, `${what} printed too much`);
  if (res.code === null) throw new ProviderError("envs", 504, `${what} was killed`);
  if (res.code !== 0) {
    throw new ProviderError(
      "envs",
      502,
      `${what} exited with ${res.code}: ${res.stderr.trim().slice(-300)}`,
    );
  }
  const out = res.stdout;
  try {
    return JSON.parse(out) as unknown;
  } catch {
    throw new ProviderError("envs", 502, `${what} did not print JSON`);
  }
}

async function runList(cfg: EnvsConfig, env: Record<string, string>) {
  const listed = Listed.safeParse(await runJson(cfg, env, ["list", "--json"]));
  if (!listed.success) throw new ProviderError("envs", 502, "list printed an unexpected shape");
  return listed.data;
}

const ProxyJson = z.looseObject({ up: z.boolean(), hosts: z.array(z.string()).default([]) });
export type ProxyStatus = { up: boolean; hosts: string[] };

// The local proxy in front of the envs, and the hosts it serves.
export async function readProxy(
  cfg: EnvsConfig,
  env: Record<string, string>,
): Promise<ProxyStatus> {
  const parsed = ProxyJson.safeParse(await runJson(cfg, env, ["proxy", "status", "--json"]));
  if (!parsed.success)
    throw new ProviderError("envs", 502, "proxy status printed an unexpected shape");
  return { up: parsed.data.up, hosts: parsed.data.hosts };
}

// Optional in the provider's contract for the tree: any failure there means "unknown", never
// an error for the whole tree. The status view reads it with readProxy and shows the error.
export async function proxyStatus(
  cfg: EnvsConfig,
  env: Record<string, string>,
): Promise<ProxyStatus | null> {
  return readProxy(cfg, env).catch(() => null);
}

// The services every env shares (database, mail, storage): how many containers run, the
// envs that use them and their ports.
const SharedJson = z.looseObject({
  running: z.number().int().nonnegative(),
  envs: z.array(z.string()).default([]),
  ports: z.record(z.string(), z.number().int()).default({}),
});
export type SharedStatus = { running: number; envs: string[]; ports: Record<string, number> };

export async function sharedStatus(
  cfg: EnvsConfig,
  env: Record<string, string>,
): Promise<SharedStatus> {
  const parsed = SharedJson.safeParse(await runJson(cfg, env, ["shared", "status", "--json"]));
  if (!parsed.success)
    throw new ProviderError("envs", 502, "shared status printed an unexpected shape");
  const { running, envs, ports } = parsed.data;
  return { running, envs, ports };
}

// What removing an env would throw away, from the provider's dry run, which touches nothing.
// Uncommitted changes and commits in no remote, per repo; `recoverableOnly` when every change
// is a moved submodule pointer, which loses no work.
const Lines = z.record(z.string(), z.array(z.string())).default({});
const PreviewJson = z.looseObject({
  ok: z.literal(true),
  dry_run: z.literal(true),
  dirty: Lines,
  unpublished: Lines,
  recoverable_only: z.boolean().default(false),
  warnings: z.array(z.looseObject({ step: z.string(), detail: z.string() })).default([]),
});
export type RemovePreview = {
  dirty: Record<string, string[]>;
  unpublished: Record<string, string[]>;
  recoverableOnly: boolean;
  warnings: string[];
  // What the user is shown as lost, hashed: a remove that would lose work runs only when the
  // provider's dry run still gives this same value (jobs.ts).
  fingerprint: string;
};

// Sorted keys, so the same losses always hash the same.
const sorted = (r: Record<string, string[]>) =>
  Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b)));
const fingerprintOf = (dirty: Record<string, string[]>, unpublished: Record<string, string[]>) =>
  new Bun.CryptoHasher("sha256")
    .update(JSON.stringify({ dirty: sorted(dirty), unpublished: sorted(unpublished) }))
    .digest("hex");

export async function removePreview(
  cfg: EnvsConfig,
  env: Record<string, string>,
  name: string,
): Promise<RemovePreview> {
  if (!ENV_NAME.test(name)) throw new LaunchError(`invalid env name ${name}`);
  const args = ["remove", name, "--dry-run", "--json"];
  const parsed = PreviewJson.safeParse(await runJson(cfg, env, args, PREVIEW_TIMEOUT_MS));
  if (!parsed.success)
    throw new ProviderError("envs", 502, "remove --dry-run printed an unexpected shape");
  const nonEmpty = (r: Record<string, string[]>) =>
    Object.fromEntries(Object.entries(r).filter(([, lines]) => lines.length > 0));
  const dirty = nonEmpty(parsed.data.dirty);
  const unpublished = nonEmpty(parsed.data.unpublished);
  return {
    dirty,
    unpublished,
    recoverableOnly: parsed.data.recoverable_only,
    warnings: parsed.data.warnings.map((w) => `${w.step}: ${w.detail}`),
    fingerprint: fingerprintOf(dirty, unpublished),
  };
}

// The CLI prints a dash for "nothing here"; the app shows nothing instead.
const status = (s: string | null | undefined) => (s && !/^[\s—-]*$/.test(s) ? s : null);

async function isDir(path: string) {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}

// A checkout's marker: a .git directory, or the .git file of a git worktree; never a symlink.
async function hasGit(dir: string) {
  const s = await lstat(join(dir, ".git")).catch(() => null);
  return s !== null && (s.isDirectory() || s.isFile());
}

// The CLI says which envs exist; the disk says which checkouts each one has. Never the disk
// alone: the root also holds the CLI's own service dirs and leftovers.
export async function listEnvs(cfg: EnvsConfig, env: Record<string, string>): Promise<Env[]> {
  const listed = await runList(cfg, env);
  const root = await realpath(cfg.root).catch(() => {
    throw new ProviderError("envs", 502, `root ${cfg.root} does not exist`);
  });
  return Promise.all(
    listed.map(async (e): Promise<Env> => {
      const base = {
        name: e.env,
        branch: e.branch ?? null,
        url: e.url ?? null,
        repos: e.repos.map((r) => ({
          repo: r.repo,
          branch: r.branch ?? null,
          docker: status(r.docker),
          servers: status(r.servers),
        })),
      };
      if (!ENV_NAME.test(e.env)) return { ...base, dirs: [], problem: "nombre no válido" };
      const dir = join(root, e.env);
      // The env itself must be a real directory under the root, not a link to somewhere else.
      const self = await lstat(dir).catch(() => null);
      if (self && !self.isDirectory())
        return { ...base, dirs: [], problem: "no es un directorio real" };
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
      if (!entries) return { ...base, dirs: [], problem: `no está en ${cfg.root}` };
      const dirs: string[] = [];
      for (const entry of entries) {
        // Symlinks are skipped: a checkout must live inside the env.
        if (!entry.isDirectory() || !DIR_NAME.test(entry.name)) continue;
        if (await hasGit(join(dir, entry.name))) dirs.push(entry.name);
      }
      dirs.sort();
      return { ...base, dirs, problem: dirs.length === 0 ? "sin repos en disco" : null };
    }),
  );
}

export const ENV_LOCATION =
  /^env:([a-z0-9][a-z0-9._-]{0,62})(?:\/([A-Za-z0-9][A-Za-z0-9._-]{0,100}))?$/;
export const isEnvLocation = (id: string) => id.startsWith("env:");

export const envLocations = (e: Env): { id: string; label: string }[] =>
  e.problem
    ? []
    : [
        { id: `env:${e.name}`, label: `${e.name} (entorno completo)` },
        ...e.dirs.map((d) => ({ id: `env:${e.name}/${d}`, label: `${e.name}/${d}` })),
      ];

// Checked on every launch: the env must be listed by the CLI right now, and the directory
// must resolve, through any symlink, to a checkout inside it. `env:<name>` is the env's own
// directory, which holds checkouts but is not one. These checks are not atomic with the
// spawn: a local process swapping directories in between is outside the threat model.
// A read (git status, a diff) passes the cached list as `envs`: the disk checks still run.
export async function resolveEnvLocation(
  cfg: HostConfig["envs"],
  env: Record<string, string>,
  id: string,
  envs?: Env[],
): Promise<Location> {
  if (!cfg) throw new LaunchError("no env provider configured");
  const match = ENV_LOCATION.exec(id);
  if (!match) throw new LaunchError(`unknown location ${id}`);
  const [, name = "", dir] = match;
  const found = (envs ?? (await listEnvs(cfg, env))).find((e) => e.name === name);
  if (!found) throw new LaunchError(`env ${name} is not listed by the env provider`);
  if (found.problem) throw new LaunchError(`env ${name}: ${found.problem}`);
  if (dir !== undefined && !found.dirs.includes(dir)) {
    throw new LaunchError(`env ${name} has no checkout ${dir}`);
  }
  const envRoot = join(await realpath(cfg.root), name);
  const target = dir === undefined ? envRoot : join(envRoot, dir);
  const cwd = await realpath(target).catch(() => {
    throw new LaunchError(`location ${id} does not exist`);
  });
  if (cwd !== target) throw new LaunchError(`location ${id} leaves the env`);
  if (!(await isDir(cwd))) throw new LaunchError(`location ${id} is not a directory`);
  return { id, label: dir === undefined ? name : `${name}/${dir}`, cwd };
}

// No --json, so the progress is visible in the terminal; --yes, so it never asks (never stops
// other envs, cleans up a failed create). Every element is validated on its own; nothing
// reaches a shell. --new creates `feature/<key>` from the default branch where a repo lacks
// it. A review env's PR repos check out their PRs' branches, which exist on origin, so they
// are only tracked; the kickoff checks each one is at its PR's head before the review starts.
export function createArgv(cfg: HostConfig["envs"], req: CreateEnvRequest): string[] {
  if (!cfg) throw new LaunchError("no env provider configured");
  const { name, repos, branch, branches } = req;
  // Rechecked here, not only in the route: a value that looks like an option never passes.
  if (!ENV_NAME.test(name)) throw new LaunchError(`invalid env name ${name}`);
  if (!ISSUE_KEY.test(branch)) throw new LaunchError(`invalid branch ${branch}`);
  if (repos.length === 0) throw new LaunchError("choose at least one repo");
  const unknown = repos.filter((r) => !cfg.repos.includes(r));
  if (unknown.length > 0) throw new LaunchError(`unknown repos ${unknown.join(", ")}`);
  const unique = [...new Set(repos)];
  const own = Object.entries(branches ?? {});
  if (branches && own.length === 0) throw new LaunchError("no branch to review");
  for (const [r, b] of own) {
    if (!unique.includes(r)) throw new LaunchError(`branch for ${r}, which is not in the env`);
    if (!BRANCH.test(b)) throw new LaunchError(`no valid branch for ${r}`);
  }
  // A repo with its own branch goes as repo@branch; the rest take the ticket's new branch.
  const specs = unique.map((r) => (branches?.[r] ? `${r}@${branches[r]}` : r));
  return [
    cfg.bin,
    "create",
    name,
    "--repos",
    specs.join(","),
    "--branch",
    ticketBranch(branch),
    "--new",
    "--yes",
  ];
}
