import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../../config.ts";
import { LaunchError, resolveLocation } from "../../launching.ts";
import { isInside } from "../../paths.ts";
import type { Terminals } from "../terminals/contract.ts";
import { GitError, runGit } from "./run.ts";
import { isRepoRoot, readStatus, type Where } from "./status.ts";

// A fetch talks to the network; past this it is given up.
export const FETCH_TIMEOUT_MS = 60_000;

export type RefusalReason =
  | "busy"
  | "terminal_inside"
  | "detached"
  | "no_upstream"
  | "dirty"
  | "diverged"
  | "env_checkout"
  | "not_a_repo"
  // Native worktrees (server/features/projects/native.ts).
  | "no_root"
  | "bad_branch"
  | "bad_base"
  | "exists"
  | "in_use"
  | "not_app_worktree"
  | "ignored"
  | "submodules"
  // Repos added from the tree (server/features/projects/places.ts).
  | "bad_folder"
  | "overlaps"
  | "not_removable"
  // Stage, commit and push (server/features/git/stage.ts).
  | "locked"
  | "not_found"
  | "conflict"
  | "nested"
  | "markers"
  | "not_hunkable"
  | "stale"
  | "nothing_staged"
  | "no_identity"
  | "commit_failed"
  | "no_remote"
  | "behind";

// The app will not touch the checkout in its current state. Git never ran, or only read.
export class GitRefusal extends Error {
  constructor(
    readonly reason: RefusalReason,
    message: string,
  ) {
    super(message);
  }
}

// ssh reads the terminal itself, so GIT_TERMINAL_PROMPT does not stop a passphrase or host
// key prompt; batch mode does. A command the user set for git is kept as it is.
export const network = (env: Record<string, string>) => ({
  ...env,
  GIT_SSH_COMMAND: env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
});

export async function fetchRemote(at: Where) {
  await runGit(at.bin, at.cwd, ["fetch", "--prune", "--quiet"], {
    env: network(at.env),
    timeoutMs: FETCH_TIMEOUT_MS,
  });
}

// One write at a time per checkout: a click and the timer never race on git's locks.
const busy = new Set<string>();
export async function exclusive<T>(cwd: string, run: () => Promise<T>): Promise<T> {
  if (busy.has(cwd)) throw new GitRefusal("busy", "Ya se está actualizando este checkout.");
  busy.add(cwd);
  try {
    return await run();
  } finally {
    busy.delete(cwd);
  }
}

// Read at request time, and again right before a write: the tree's copy goes stale.
export async function noTerminalInside(terminals: Pick<Terminals, "list">, dir: string) {
  for (const t of await terminals.list()) {
    if (t.state !== "running") continue;
    const cwd = await realpath(t.cwd).catch(() => t.cwd);
    if (isInside(dir, cwd)) {
      throw new GitRefusal(
        "terminal_inside",
        "Hay una terminal en marcha en este checkout; páralas antes de tocarlo.",
      );
    }
  }
}

// What happened to the submodules after the branch moved: the ones moved to the commit the repo
// records (or set up), the ones left as they were and why, and git's words if it failed.
export type SubmoduleSync = {
  moved: string[];
  kept: { path: string; why: string }[];
  error: string | null;
};

export type PullResult = {
  result: "updated" | "up_to_date";
  branch: string;
  from: string | null;
  to: string | null;
  commits: number;
  // null for a repo without submodules.
  submodules: SubmoduleSync | null;
};

// A submodule is moved like `git submodule update --init --recursive` does, except one with its
// own changes or with commits no remote has: moving it would hide them, so it is kept and said.
// ponytail: only the top level is checked; nested ones follow --recursive. Check them too if a
// nested submodule ever carries work of its own.
// The path in a `git submodule status` line, `<flag><sha> <path>[ (<describe>)]`; the path may
// hold spaces of its own.
export const submodulePath = (line: string) =>
  /^.[0-9a-f]+ (.+?)(?: \([^()]*\))?$/.exec(line)?.[1] ?? "";

export async function syncSubmodules(at: Where): Promise<SubmoduleSync | null> {
  const listed = (await runGit(at.bin, at.cwd, ["submodule", "status"], { env: at.env })).out;
  const lines = listed.split("\n").filter(Boolean);
  if (lines.length === 0) return null;
  const moved: string[] = [];
  const kept: SubmoduleSync["kept"] = [];
  for (const line of lines) {
    const flag = line[0];
    const path = submodulePath(line);
    if (flag === "-") moved.push(path);
    if (flag !== "+") continue;
    const sub = { ...at, cwd: join(at.cwd, path) };
    const changed = (
      await runGit(sub.bin, sub.cwd, ["status", "--porcelain", "--untracked-files=no"], {
        env: at.env,
      })
    ).out.trim();
    const local = Number(
      (
        await runGit(sub.bin, sub.cwd, ["rev-list", "--count", "HEAD", "--not", "--remotes"], {
          env: at.env,
        })
      ).out.trim(),
    );
    if (changed) kept.push({ path, why: "tiene cambios sin commitear" });
    else if (local > 0) {
      kept.push({ path, why: `tiene ${local} ${local === 1 ? "commit" : "commits"} sin subir` });
    } else moved.push(path);
  }
  if (moved.length === 0) return { moved, kept, error: null };
  try {
    await runGit(at.bin, at.cwd, ["submodule", "update", "--init", "--recursive", "--", ...moved], {
      env: network(at.env),
      timeoutMs: 2 * FETCH_TIMEOUT_MS,
    });
    return { moved, kept, error: null };
  } catch (err) {
    if (!(err instanceof GitError)) throw err;
    return { moved: [], kept, error: err.message };
  }
}

// `git pull --ff-only` and then `git submodule update --init --recursive`, as the repos' own
// READMEs keep a checkout up to date: never a merge commit, never a rebase, never another
// branch. Local changes do not block it; git itself refuses when the update would overwrite
// one, and that refusal is passed on with git's list of files.
export async function fastForward(
  at: Where,
  terminals: Pick<Terminals, "list">,
): Promise<PullResult> {
  await noTerminalInside(terminals, at.cwd);
  await fetchRemote(at);
  const s = await readStatus(at);
  if (!s.branch) throw new GitRefusal("detached", "HEAD separado: no hay rama que avanzar.");
  if (!s.upstream) {
    throw new GitRefusal("no_upstream", `La rama ${s.branch} no sigue ninguna rama remota.`);
  }
  if (s.behind && s.ahead) {
    throw new GitRefusal(
      "diverged",
      `${s.branch} tiene ${s.ahead} commits que ${s.upstream} no tiene: no avanza sin merge.`,
    );
  }
  await noTerminalInside(terminals, at.cwd);
  let to = s.oid;
  if (s.behind) {
    try {
      // The submodules move below, once, whatever the user's submodule.recurse says.
      await runGit(
        at.bin,
        at.cwd,
        ["-c", "submodule.recurse=false", "merge", "--ff-only", "--no-edit", "@{upstream}"],
        { env: at.env },
      );
    } catch (err) {
      // git's error keeps its last 300 characters: a long file list pushes the first line out.
      const words = err instanceof GitError ? err.message : "";
      if (
        words.includes("would be overwritten") ||
        words.includes("commit your changes or stash")
      ) {
        throw new GitRefusal(
          "dirty",
          `Tus cambios sin commitear se pisarían: ${overwritten(words)}.`,
        );
      }
      throw err;
    }
    to = (await runGit(at.bin, at.cwd, ["rev-parse", "HEAD"], { env: at.env })).out.trim();
  }
  return {
    result: s.behind ? "updated" : "up_to_date",
    branch: s.branch,
    from: s.oid,
    to,
    commits: s.behind ?? 0,
    submodules: await syncSubmodules(at),
  };
}

// The files git lists, one per tab-led line, in its "would be overwritten" refusal.
const overwritten = (message: string) =>
  message
    .split("\n")
    .filter((l) => l.startsWith("\t"))
    .map((l) => l.trim())
    .join(", ") || "git no dice cuáles";

export type RepoUpdate = {
  location: string;
  label: string;
  result: "updated" | "up_to_date" | "skipped" | "failed";
  reason: RefusalReason | null;
  detail: string | null;
  commits: number;
  submodules: SubmoduleSync | null;
};

// "Actualizar repos": every main checkout of the profile, each on its own. A refusal or a
// failed fetch on one is its line in the answer and never stops the others. Env checkouts
// are the env CLI's to update; loose worktrees are left as they are.
export async function updateRepos(
  config: Config,
  terminals: Pick<Terminals, "env" | "list">,
): Promise<RepoUpdate[]> {
  const bin = config.git.bin;
  if (!bin) return [];
  const env = await terminals.env;
  return Promise.all(
    config.repos.map(async (r): Promise<RepoUpdate> => {
      const line = {
        location: `repo:${r.id}`,
        label: r.id,
        reason: null,
        detail: null,
        submodules: null,
      };
      try {
        const at = { bin, cwd: resolveLocation(config, line.location).cwd, env };
        if (!(await isRepoRoot(at))) {
          throw new GitRefusal("not_a_repo", "La carpeta no es la raíz de un repo de git.");
        }
        const done = await exclusive(at.cwd, () => fastForward(at, terminals));
        return {
          ...line,
          result: done.result,
          commits: done.commits,
          submodules: done.submodules,
        };
      } catch (err) {
        if (err instanceof GitRefusal) {
          return {
            ...line,
            result: "skipped",
            reason: err.reason,
            detail: err.message,
            commits: 0,
          };
        }
        if (err instanceof GitError || err instanceof LaunchError) {
          return { ...line, result: "failed", detail: err.message, commits: 0 };
        }
        throw err;
      }
    }),
  );
}
