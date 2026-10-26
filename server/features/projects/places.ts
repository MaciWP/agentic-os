import { readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { z } from "zod";
import { APP_ROOT, type Config, ConfigSchema, DATA_DIR, type RepoConfig } from "../../config.ts";
import { LaunchError } from "../../launching.ts";
import { isInside } from "../../paths.ts";
import { isRepoRoot } from "../git/status.ts";
import { GitRefusal, noTerminalInside } from "../git/sync.ts";
import type { Terminals } from "../terminals/contract.ts";

// Repos the user adds from the tree, chosen in the app's folder picker. They go into
// data/config.json as local-only repos, so they get git, worktrees and "Actualizar repos" like
// the configured ones; the PTY host reads the file again on its next launch. Removing one only
// takes it off the list, never touches the folder.

export const CONFIG_PATH = join(DATA_DIR, "config.json");

// A repo id from a folder name: what the config's ids look like, unique among the repos.
export function repoId(name: string, taken: string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "repo";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

// One change to the file at a time; each re-reads it, so a hand edit in between is kept.
let writing = Promise.resolve();

// Rewrites the repos list in config.json. The whole file must still parse, and the new file
// replaces the old in one rename, so a failure leaves the old one as it was.
async function editRepos(
  configPath: string,
  edit: (repos: unknown[]) => unknown[],
): Promise<RepoConfig[]> {
  const run = writing.then(async () => {
    const raw = JSON.parse(await readFile(configPath, "utf8").catch(() => "{}")) as Record<
      string,
      unknown
    >;
    const next = { ...raw, repos: edit(Array.isArray(raw.repos) ? raw.repos : []) };
    const parsed = ConfigSchema.safeParse(next);
    if (!parsed.success)
      throw new LaunchError(`config.json would not be valid: ${z.prettifyError(parsed.error)}`);
    const tmp = `${configPath}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
    await rename(tmp, configPath);
    return parsed.data.repos;
  });
  writing = run.then(
    () => {},
    () => {},
  );
  return run;
}

// The running config follows the file: the server read it once at start.
const adopt = (config: Config, repos: RepoConfig[]) => {
  config.repos.splice(0, config.repos.length, ...repos);
};

export async function addRepo(
  config: Config,
  env: Record<string, string>,
  path: string,
  configPath = CONFIG_PATH,
  appRoot = APP_ROOT,
): Promise<RepoConfig> {
  if (!isAbsolute(path)) throw new GitRefusal("bad_folder", "La ruta tiene que ser absoluta.");
  const dir = await realpath(path).catch(() => null);
  if (!dir || !(await stat(dir)).isDirectory())
    throw new GitRefusal("bad_folder", `${path} no es una carpeta.`);
  const bin = config.git.bin;
  if (!bin) throw new LaunchError("git.bin is not set in the profile");
  if (!(await isRepoRoot({ bin, cwd: dir, env })))
    throw new GitRefusal("not_a_repo", "La carpeta no es la raíz de un repo de git.");
  // The tree files a checkout by where it sits: one inside another, the envs root or the
  // worktrees root would show twice or vanish. The app's own folder, itself, may be added:
  // the tree then shows Agentic OS as that repo.
  const app = await realpath(appRoot).catch(() => null);
  const others = [
    ...(app === dir ? [] : [{ name: "Agentic OS", path: appRoot }]),
    ...(config.envs ? [{ name: "la carpeta de entornos", path: config.envs.root }] : []),
    ...(config.worktrees ? [{ name: "la carpeta de worktrees", path: config.worktrees.root }] : []),
    ...config.repos.map((r) => ({ name: r.id, path: r.localPath })),
  ];
  for (const o of others) {
    const other = await realpath(o.path).catch(() => null);
    if (other && (isInside(other, dir) || isInside(dir, other)))
      throw new GitRefusal("overlaps", `${dir} se solapa con ${o.name}.`);
  }
  const id = repoId(
    basename(dir),
    config.repos.map((r) => r.id),
  );
  const repos = await editRepos(configPath, (list) => [...list, { id, localPath: dir }]);
  adopt(config, repos);
  return repos.find((r) => r.id === id) as RepoConfig;
}

// Only a repo added here (local-only, in no group) can leave the list from the tree.
export const removable = (r: RepoConfig) => !r.group && !r.owner;

export async function removeRepo(
  config: Config,
  terminals: Pick<Terminals, "list">,
  id: string,
  configPath = CONFIG_PATH,
): Promise<void> {
  const repo = config.repos.find((r) => r.id === id);
  if (!repo || !removable(repo))
    throw new GitRefusal("not_removable", "Ese repo no se puede quitar desde aquí.");
  const dir = await realpath(repo.localPath).catch(() => repo.localPath);
  await noTerminalInside(terminals, dir);
  const repos = await editRepos(configPath, (list) =>
    list.filter((r) => (r as { id?: unknown }).id !== id),
  );
  adopt(config, repos);
}
