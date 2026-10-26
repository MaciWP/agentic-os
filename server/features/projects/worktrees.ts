import { realpath, stat } from "node:fs/promises";
import type { HostConfig, RepoConfig } from "../../config-host.ts";
import { errorMessage } from "../../error-message.ts";
import { LaunchError, type Location } from "../../launching.ts";
import { isInside } from "../../paths.ts";
import { runGit } from "../git/run.ts";

// One record of `git worktree list --porcelain -z`.
export type PorcelainEntry = {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
};

// -z ends every attribute with a NUL and every record with one more, so a path may hold any
// byte but NUL. Attributes the tree does not use (locked, prunable) are skipped.
export function parsePorcelain(out: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = [];
  let current: PorcelainEntry | null = null;
  for (const field of out.split("\0")) {
    if (field === "") {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    const space = field.indexOf(" ");
    const key = space < 0 ? field : field.slice(0, space);
    const value = space < 0 ? "" : field.slice(space + 1);
    if (key === "worktree") {
      if (current) entries.push(current);
      current = { path: value, head: null, branch: null, detached: false, bare: false };
    } else if (!current) {
    } else if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "detached") current.detached = true;
    else if (key === "bare") current.bare = true;
  }
  if (current) entries.push(current);
  return entries;
}

export type Worktree = {
  path: string;
  branch: string | null;
  head: string | null;
  // Detached worktrees get none: a location names a branch, never a commit.
  location: string | null;
};

export type RepoTree = {
  id: string;
  // The checkout `repo:<id>` launches in.
  main: { path: string; branch: string | null } | null;
  // Worktrees outside every env and not nested in another checkout.
  worktrees: Worktree[];
  error: string | null;
};

// A worktree inside an env, keyed by its real path: the env node shows which repo and
// branch each of its directories is.
export type EnvCheckout = { repo: string; branch: string | null };

export type RepoScan = { repos: RepoTree[]; envCheckouts: Map<string, EnvCheckout> };

export const worktreeLocation = (repo: string, branch: string) => `wt:${repo}:${branch}`;
export const isWorktreeLocation = (id: string) => id.startsWith("wt:");

const real = (path: string) => realpath(path).catch(() => null);
// Strictly below: a path is not nested in itself.
const below = (path: string, dir: string) => path !== dir && isInside(dir, path);

type Scanned = { repo: RepoConfig; main: string | null; entries: PorcelainEntry[] };

// Every repo of the profile with the worktrees git lists for it. Paths are compared real on
// both sides, so a symlinked root or /var against /private/var classify the same. A record
// whose path is gone (prunable) is dropped. One failing repo carries its own error.
export async function scanRepos(
  config: HostConfig,
  env: Record<string, string>,
): Promise<RepoScan> {
  const bin = config.git.bin;
  const envRoot = config.envs ? await real(config.envs.root) : null;
  const scanned = await Promise.all(
    config.repos.map(async (repo): Promise<Scanned | { repo: RepoConfig; error: string }> => {
      if (!bin) return { repo, error: "git.bin is not set in the profile" };
      const main = await real(repo.localPath);
      if (!main) return { repo, error: `${repo.localPath} does not exist` };
      try {
        const { out } = await runGit(bin, main, ["worktree", "list", "--porcelain", "-z"], { env });
        const listed = parsePorcelain(out);
        const entries: PorcelainEntry[] = [];
        for (const e of listed) {
          const path = e.bare ? null : await real(e.path);
          if (path) entries.push({ ...e, path });
        }
        return { repo, main, entries };
      } catch (err) {
        return { repo, error: errorMessage(err) };
      }
    }),
  );
  const known = scanned.flatMap((s) =>
    "entries" in s ? s.entries.map((e) => ({ repo: s.repo.id, path: e.path })) : [],
  );
  const envCheckouts = new Map<string, EnvCheckout>();
  const repos = scanned.map((s): RepoTree => {
    if (!("entries" in s)) return { id: s.repo.id, main: null, worktrees: [], error: s.error };
    // The checkout the profile names; git's first record when the profile points elsewhere.
    const main = s.entries.find((e) => e.path === s.main) ?? s.entries[0];
    const worktrees: Worktree[] = [];
    for (const e of s.entries) {
      if (e === main) continue;
      if (envRoot && below(e.path, envRoot)) {
        envCheckouts.set(e.path, { repo: s.repo.id, branch: e.branch });
        continue;
      }
      // A submodule's worktree lives inside another repo's checkout, which is the place to
      // work. Worktrees nested in their own repo (`.worktrees/x`) stay.
      if (known.some((k) => k.repo !== s.repo.id && below(e.path, k.path))) continue;
      const location = e.branch && !e.detached ? worktreeLocation(s.repo.id, e.branch) : null;
      worktrees.push({ path: e.path, branch: e.branch, head: e.head, location });
    }
    worktrees.sort((a, b) => (a.branch ?? a.path).localeCompare(b.branch ?? b.path));
    return {
      id: s.repo.id,
      main: main ? { path: main.path, branch: main.branch } : null,
      worktrees,
      error: null,
    };
  });
  return { repos, envCheckouts };
}

// Checked on every launch against a fresh `git worktree list`: the id names a repo of the
// profile and a branch git has checked out in one of its loose worktrees. The client's
// branch is only ever compared, never passed to git.
export async function resolveWorktreeLocation(
  config: HostConfig,
  env: Record<string, string>,
  id: string,
): Promise<Location> {
  const colon = id.lastIndexOf(":");
  const repoId = id.slice("wt:".length, colon);
  const branch = id.slice(colon + 1);
  if (!isWorktreeLocation(id) || colon < "wt:".length || !repoId || !branch)
    throw new LaunchError(`unknown location ${id}`);
  const { repos } = await scanRepos(config, env);
  const repo = repos.find((r) => r.id === repoId);
  if (!repo) throw new LaunchError(`unknown repo ${repoId}`);
  if (repo.error) throw new LaunchError(`${repoId}: ${repo.error}`);
  const found = repo.worktrees.find((w) => w.location === id);
  if (!found) throw new LaunchError(`${repoId} has no worktree on ${branch}`);
  if (!(await stat(found.path).catch(() => null))?.isDirectory())
    throw new LaunchError(`location ${id} is not a directory`);
  return { id, label: `${repoId}/${branch}`, cwd: found.path };
}
