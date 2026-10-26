import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../../config.ts";
import { LaunchError, resolveLocation } from "../../launching.ts";
import { isInside } from "../../paths.ts";
import { GitError, runGit } from "../git/run.ts";
import { isRepoRoot, type Where } from "../git/status.ts";
import {
  exclusive,
  FETCH_TIMEOUT_MS,
  fetchRemote,
  GitRefusal,
  network,
  noTerminalInside,
} from "../git/sync.ts";
import type { Terminals } from "../terminals/contract.ts";
import { resolveWorktreeLocation, worktreeLocation } from "./worktrees.ts";

// Adding checks out every file and runs the repo's own hooks: it can take a while on a big
// repo, and must still answer before Bun's idle reset (server/deadline.ts).
const ADD_TIMEOUT_MS = 90_000;
const REMOVE_TIMEOUT_MS = 60_000;
const MAX_BRANCH = 200;
// The picker lists the most recent ones; a base is checked on its own, never against this.
const MAX_REFS = 500;
const SHOWN_IGNORED = 10;

const real = (path: string) => realpath(path).catch(() => null);

// The root as it is now, or why the app cannot add worktrees there. It must stay apart from
// every checkout and from the envs root: the tree drops worktrees nested in another repo and
// files those under the envs root as env checkouts, so a worktree there would vanish.
export async function worktreeRoot(
  config: Config,
): Promise<{ root: string | null; error: string | null }> {
  const cfg = config.worktrees;
  if (!cfg) return { root: null, error: "El perfil no tiene worktrees.root." };
  const root = await real(cfg.root);
  if (!root) return { root: null, error: `${cfg.root} no existe.` };
  const others = [
    ...(config.envs ? [{ name: "la carpeta de entornos", path: config.envs.root }] : []),
    ...config.repos.map((r) => ({ name: `el checkout de ${r.id}`, path: r.localPath })),
  ];
  for (const o of others) {
    const path = await real(o.path);
    if (path && (isInside(path, root) || isInside(root, path))) {
      return { root: null, error: `${cfg.root} se solapa con ${o.name}.` };
    }
  }
  return { root, error: null };
}

async function usableRoot(config: Config) {
  const { root, error } = await worktreeRoot(config);
  if (!root) throw new GitRefusal("no_root", error ?? "Sin carpeta de worktrees.");
  return root;
}

// The repo's main checkout, as fetch and pull resolve it: the same path keys the lock.
async function mainCheckout(config: Config, env: Record<string, string>, repoId: string) {
  const bin = config.git.bin;
  if (!bin) throw new LaunchError("git.bin is not set in the profile");
  const at: Where = { bin, cwd: resolveLocation(config, `repo:${repoId}`).cwd, env };
  if (!(await isRepoRoot(at))) {
    throw new GitRefusal("not_a_repo", "La carpeta no es la raíz de un repo de git.");
  }
  return at;
}

// git's own check, and its answer must be the name itself: `@{-1}` passes and expands to
// the branch checked out before.
async function checkBranch(at: Where, branch: string) {
  const bad = new GitRefusal("bad_branch", `"${branch}" no es un nombre de rama válido.`);
  if (!branch || branch.length > MAX_BRANCH || branch.startsWith("-") || branch.includes("@{")) {
    throw bad;
  }
  const out = await runGit(at.bin, at.cwd, ["check-ref-format", "--branch", branch], {
    env: at.env,
  }).catch((err: unknown) => {
    if (err instanceof GitError) throw bad;
    throw err;
  });
  if (out.out.trim() !== branch) throw bad;
}

// One folder name per branch: `feat/x` and `feat-x` share it, and the second is refused as
// existing rather than overwritten.
export function slugOf(branch: string) {
  return branch.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "");
}

const isRepoSegment = (id: string) => id !== "" && id !== "." && id !== ".." && !/[/\\\0]/.test(id);

// A full refname under heads or remotes that exists now. The prefix keeps it off git's
// options; show-ref --verify takes only an exact name.
async function hasRef(at: Where, ref: string) {
  if (!/^refs\/(heads|remotes)\//.test(ref) || ref.endsWith("/HEAD")) return false;
  const r = await runGit(at.bin, at.cwd, ["show-ref", "--verify", "--quiet", ref], {
    env: at.env,
    ok: [0, 1],
  });
  return r.code === 0;
}

// The remote's default branch: origin/HEAD when the clone has it, else asked to the remote.
// `remote set-head` is never run: it would change the user's clone behind their back.
async function defaultBase(at: Where): Promise<string | null> {
  const sym = await runGit(
    at.bin,
    at.cwd,
    ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    {
      env: at.env,
      ok: [0, 1],
    },
  ).catch(() => null);
  let ref = sym?.code === 0 ? sym.out.trim() : null;
  if (!ref) {
    const ls = await runGit(at.bin, at.cwd, ["ls-remote", "--symref", "origin", "HEAD"], {
      env: network(at.env),
      timeoutMs: FETCH_TIMEOUT_MS,
    }).catch(() => null);
    const name = ls?.out.match(/^ref: refs\/heads\/(\S+)\tHEAD$/m)?.[1];
    if (name) ref = `refs/remotes/origin/${name}`;
  }
  return ref && (await hasRef(at, ref)) ? ref : null;
}

export type Branches = { local: string[]; remote: string[]; base: string | null };

// For the picker: full refnames, most recently committed first.
export async function listBranches(
  config: Config,
  env: Record<string, string>,
  repoId: string,
): Promise<Branches> {
  const at = await mainCheckout(config, env, repoId);
  const { out } = await runGit(
    at.bin,
    at.cwd,
    [
      "for-each-ref",
      `--count=${MAX_REFS}`,
      "--sort=-committerdate",
      "--format=%(refname)",
      "refs/heads",
      "refs/remotes",
    ],
    { env },
  );
  const refs = out.split("\n").filter((r) => r && !r.endsWith("/HEAD"));
  return {
    local: refs.filter((r) => r.startsWith("refs/heads/")),
    remote: refs.filter((r) => r.startsWith("refs/remotes/")),
    base: await defaultBase(at),
  };
}

// git's refusals that are the user's to fix, with git's own words; anything else stays a
// git error.
function refusalOf(err: unknown): unknown {
  if (!(err instanceof GitError)) return err;
  const words = err.message.match(/fatal: (.*)/)?.[1] ?? err.message;
  if (/is already (used by|checked out at)/.test(words)) return new GitRefusal("in_use", words);
  if (words.includes("contains modified or untracked files")) return new GitRefusal("dirty", words);
  if (words.includes("containing submodules")) {
    return new GitRefusal(
      "submodules",
      "Tiene submódulos inicializados: git no lo quita sin forzar y la app nunca fuerza. Quítalo a mano.",
    );
  }
  return err;
}

export type AddResult = {
  location: string;
  path: string;
  branch: string;
  // local: the branch existed and is checked out as it is. remote: a new local branch
  // tracking origin's. new: a new branch off `base`, with no upstream.
  mode: "local" | "remote" | "new";
  base: string | null;
  // The fetch before adding failed: the worktree starts from what the clone already had.
  fetchError: string | null;
};

// `git worktree add` under <root>/<repo>/<slug>. An existing branch is never moved or
// reset; a new one starts from `base` or the remote's default branch after a fetch.
export async function addWorktree(
  config: Config,
  env: Record<string, string>,
  req: { repo: string; branch: string; base?: string },
): Promise<AddResult> {
  if (!isRepoSegment(req.repo)) throw new LaunchError(`unknown repo ${req.repo}`);
  const at = await mainCheckout(config, env, req.repo);
  const root = await usableRoot(config);
  const { branch } = req;
  await checkBranch(at, branch);
  const slug = slugOf(branch);
  if (!slug) throw new GitRefusal("bad_branch", `"${branch}" no da un nombre de carpeta.`);

  return exclusive(at.cwd, async () => {
    let fetchError: string | null = null;
    try {
      await fetchRemote(at);
    } catch (err) {
      if (!(err instanceof GitError)) throw err;
      fetchError = err.message;
    }

    let mode: AddResult["mode"];
    let base: string | null = null;
    let from: string[];
    if (await hasRef(at, `refs/heads/${branch}`)) {
      mode = "local";
      // The short name checks the branch out; refs/heads/<b> would detach HEAD.
      from = [branch];
    } else if (await hasRef(at, `refs/remotes/origin/${branch}`)) {
      mode = "remote";
      base = `refs/remotes/origin/${branch}`;
      from = [base];
    } else {
      mode = "new";
      if (req.base !== undefined) {
        if (!(await hasRef(at, req.base))) {
          throw new GitRefusal(
            "bad_base",
            `${req.base} no es una rama local ni remota de ${req.repo}.`,
          );
        }
        base = req.base;
      } else {
        base = await defaultBase(at);
        if (!base) {
          throw new GitRefusal(
            "bad_base",
            "No se sabe cuál es la rama por defecto del remoto: elige la base a mano.",
          );
        }
      }
      from = [base];
    }

    // Created here, never through a link: a repo folder that is a symlink could point
    // anywhere.
    const repoDir = join(root, req.repo);
    await mkdir(repoDir).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err;
    });
    const dirStat = await lstat(repoDir);
    if (!dirStat.isDirectory() || (await real(repoDir)) !== repoDir) {
      throw new GitRefusal(
        "no_root",
        `${repoDir} no es una carpeta normal dentro de worktrees.root.`,
      );
    }
    const path = join(repoDir, slug);
    if (await lstat(path).catch(() => null)) {
      throw new GitRefusal("exists", `${path} ya existe.`);
    }

    const flags =
      mode === "local"
        ? []
        : mode === "remote"
          ? ["--track", "-b", branch]
          : ["--no-track", "-b", branch];
    try {
      await runGit(at.bin, at.cwd, ["worktree", "add", ...flags, "--", path, ...from], {
        env,
        timeoutMs: ADD_TIMEOUT_MS,
      });
    } catch (err) {
      throw refusalOf(err);
    }
    return { location: worktreeLocation(req.repo, branch), path, branch, mode, base, fetchError };
  });
}

// What `git worktree remove` deletes without a word: the ignored files (.env, builds).
// Ignored folders count as one entry.
async function ignoredFiles(at: Where) {
  const { out } = await runGit(
    at.bin,
    at.cwd,
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
    { env: at.env, maxBytes: 256 * 1024 },
  );
  return out.split("\0").filter(Boolean);
}

export type RemoveResult = { location: string; path: string; branch: string };

// Only a worktree the app made (inside the root), with no terminal running in it. Changed or
// untracked files are git's to refuse; ignored files need `dropIgnored`. Never --force, and
// the branch stays.
export async function removeWorktree(
  config: Config,
  terminals: Pick<Terminals, "env" | "list">,
  req: { location: string; dropIgnored?: boolean },
): Promise<RemoveResult> {
  const env = await terminals.env;
  const wt = await resolveWorktreeLocation(config, env, req.location);
  const colon = req.location.lastIndexOf(":");
  const repoId = req.location.slice("wt:".length, colon);
  const branch = req.location.slice(colon + 1);
  const root = await usableRoot(config);
  if (!isInside(root, wt.cwd) || wt.cwd === root) {
    throw new GitRefusal(
      "not_app_worktree",
      "La app solo quita los worktrees que crea en worktrees.root; este quítalo a mano.",
    );
  }
  const main = await mainCheckout(config, env, repoId);
  await noTerminalInside(terminals, wt.cwd);

  return exclusive(main.cwd, async () => {
    const here: Where = { ...main, cwd: wt.cwd };
    const { out } = await runGit(
      here.bin,
      here.cwd,
      ["status", "--porcelain", "-z", "--untracked-files=normal"],
      { env },
    );
    // A changed tree gets git's own refusal below; ignored files only matter on a clean one.
    if (out === "" && !req.dropIgnored) {
      const ignored = await ignoredFiles(here);
      if (ignored.length > 0) {
        const shown = ignored.slice(0, SHOWN_IGNORED).join(", ");
        const more =
          ignored.length > SHOWN_IGNORED ? ` y ${ignored.length - SHOWN_IGNORED} más` : "";
        throw new GitRefusal(
          "ignored",
          `Tiene ficheros ignorados que se borrarían con él: ${shown}${more}.`,
        );
      }
    }
    await noTerminalInside(terminals, wt.cwd);
    try {
      await runGit(main.bin, main.cwd, ["worktree", "remove", "--", wt.cwd], {
        env,
        timeoutMs: REMOVE_TIMEOUT_MS,
      });
    } catch (err) {
      throw refusalOf(err);
    }
    return { location: req.location, path: wt.cwd, branch };
  });
}
