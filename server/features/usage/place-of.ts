import { existsSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import type { Config } from "../../config.ts";
import { isInside } from "../../paths.ts";

const PATH_SEP = new RegExp(`\\${sep}`);
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type Place = { ticket: string | null; location: string };

// The ticket a folder and branch work on, and where they are: an env, a native worktree, a
// configured repo or else the folder's name. The key must be the configured Jira project's,
// bounded by non-alphanumerics, so ABC-10 never matches inside ABC-1033; env folders are
// lowercase, so the match ignores case.
// The checkout a folder belongs to, so a session in `repo/src` counts under `repo`; the
// folder itself when it is in none or is gone.
export function gitRoot(cwd: string): string {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return cwd;
  }
}

export function placeOf(config: Config, cwd: string, branch: string): Place {
  const project = config.jira?.project;
  const key = project
    ? new RegExp(`(?<![A-Za-z0-9])${escapeRegex(project)}-(\\d+)(?![0-9])`, "i")
    : null;
  const m = key ? (key.exec(branch) ?? key.exec(cwd)) : null;
  const ticket = m && project ? `${project.toUpperCase()}-${m[1]}` : null;
  const envs = config.envs?.root;
  if (envs && isInside(envs, cwd) && cwd !== envs)
    return { ticket, location: relative(envs, cwd).split(PATH_SEP)[0] ?? cwd };
  const trees = config.worktrees?.root;
  if (trees && isInside(trees, cwd) && cwd !== trees)
    return { ticket, location: relative(trees, cwd).split(PATH_SEP).slice(0, 2).join("/") };
  const repo = config.repos.find((r) => isInside(r.localPath, cwd));
  return { ticket, location: repo ? repo.id : basename(gitRoot(cwd)) || cwd };
}
