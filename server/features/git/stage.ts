import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isStaged, isUnstaged } from "../../../shared/git.ts";
import { DATA_DIR } from "../../config.ts";
import { contentVersion, fileVersion, saveRecovery } from "../../recovery.ts";
import { GitError, type GitResult, type GitRun, runGit } from "./run.ts";
import { type GitFile, type GitStatus, readDiff, readStatus, type Where } from "./status.ts";
import { FETCH_TIMEOUT_MS, GitRefusal, network } from "./sync.ts";

// Hooks and commit signing run inside a commit; past this it is given up.
export const COMMIT_TIMEOUT_MS = 120_000;

const LOCKED = /index\.lock|Another git process seems to be running/;

// Every write of this file: paths are literal, never patterns (a file named `a[1].ts` or
// `:x` stays itself), and an index lock held by someone else (an agent in the same checkout)
// is a refusal to try again, not a failure.
async function write(at: Where, args: string[], opts: Partial<GitRun> = {}) {
  try {
    return await runGit(at.bin, at.cwd, ["--literal-pathspecs", ...args], { env: at.env, ...opts });
  } catch (err) {
    if (err instanceof GitError && LOCKED.test(err.message)) {
      throw new GitRefusal(
        "locked",
        "Otro proceso de git está usando este checkout (¿un agente?). Vuelve a intentarlo.",
      );
    }
    throw err;
  }
}

// The client's paths, kept only where the status lists them now: a string from the client
// is compared, never passed on.
function listed(s: GitStatus, paths: string[], keep: (f: GitFile) => boolean): GitFile[] {
  const want = new Set(paths);
  const files = s.files.filter((f) => want.has(f.path) && keep(f));
  if (files.length === 0) {
    throw new GitRefusal("not_found", "Ninguno de esos ficheros sigue así: actualiza la vista.");
  }
  return files;
}

const noConflict = (files: GitFile[]) => {
  if (files.some((f) => f.kind === "conflict")) {
    throw new GitRefusal(
      "conflict",
      "Un fichero en conflicto no se prepara así: márcalo como resuelto, uno a uno.",
    );
  }
};

// `git add -A`: new, changed and deleted files alike. A nested repo or an empty dir is
// listed with a trailing slash; adding one would record a gitlink, so it is left to a shell.
export async function stagePaths(at: Where, paths: string[]) {
  const files = listed(await readStatus(at), paths, (f) => isUnstaged(f));
  noConflict(files);
  if (files.some((f) => f.path.endsWith("/"))) {
    throw new GitRefusal("nested", "Un directorio o repo anidado se añade desde una terminal.");
  }
  await write(at, ["add", "-A", "--", ...files.map((f) => f.path)]);
}

// Back to the worktree side; before the first commit there is no HEAD to restore from. A
// rename takes its original path too, so both sides go back.
export async function unstagePaths(at: Where, paths: string[]) {
  const s = await readStatus(at);
  const files = listed(s, paths, isStaged);
  noConflict(files);
  const all = files.flatMap((f) => (f.orig ? [f.orig, f.path] : [f.path]));
  await write(
    at,
    s.oid ? ["restore", "--staged", "--", ...all] : ["rm", "--cached", "-r", "-q", "--", ...all],
  );
}

// A conflict is resolved by staging it, markers and all; git does not check. A line that
// still opens or closes a conflict refuses it.
export async function markResolved(at: Where, path: string) {
  const [file] = listed(await readStatus(at), [path], (f) => f.kind === "conflict");
  const text = await readFile(join(at.cwd, (file as GitFile).path), "utf8").catch(() => "");
  if (/^(<{7}|>{7})( |$)/m.test(text)) {
    throw new GitRefusal("markers", `${path} aún tiene marcas de conflicto (<<<<<<< o >>>>>>>).`);
  }
  await write(at, ["add", "--", (file as GitFile).path]);
}

// Puts the worktree side of tracked files back to what is staged. New files are never
// deleted here, and a conflict is resolved, not thrown away.
export async function discardIndex(at: Where) {
  const result = await runGit(at.bin, at.cwd, ["ls-files", "--stage", "-z"], {
    env: at.env,
    maxBytes: 8 * 1024 * 1024,
  });
  if (result.truncated)
    throw new GitRefusal("stale", "El índice supera el límite de lectura segura.");
  const entries = new Map<string, string>();
  for (const record of result.out.split("\0")) {
    if (!record) continue;
    const path = record.slice(record.indexOf("\t") + 1);
    entries.set(path, `${entries.get(path) ?? ""}${record}\0`);
  }
  return entries;
}
export async function discardSnapshot(at: Where, path: string, indexEntry?: string) {
  const index =
    indexEntry ??
    (
      await runGit(
        at.bin,
        at.cwd,
        ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", path],
        { env: at.env },
      )
    ).out;
  const file = await fileVersion(join(at.cwd, path)).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return { bytes: null, version: "missing" };
    throw err;
  });
  return { bytes: file.bytes, version: contentVersion(`${path}\0${index}\0${file.version}`) };
}

export async function discardPaths(
  at: Where,
  paths: string[],
  expected: Record<string, string> = {},
  dataDir = DATA_DIR,
) {
  const s = await readStatus(at);
  const want = new Set(paths);
  if (s.files.some((f) => want.has(f.path) && (f.kind === "untracked" || f.kind === "conflict")))
    throw new GitRefusal("conflict", "Solo se descartan ficheros versionados sin conflictos.");
  const files = listed(s, paths, isUnstaged);
  if (files.length !== want.size)
    throw new GitRefusal("stale", "La lista ha cambiado: actualiza la vista.");
  const snapshots = [];
  for (const file of files) {
    const snapshot = await discardSnapshot(at, file.path);
    if (expected[file.path] !== snapshot.version)
      throw new GitRefusal(
        "stale",
        `${file.path} ha cambiado: actualiza la vista antes de descartar.`,
      );
    snapshots.push({ path: file.path, ...snapshot });
  }
  const recovery: string[] = [];
  for (const s of snapshots)
    if (s.bytes)
      recovery.push(await saveRecovery(dataDir, join(at.cwd, s.path), "git-discard", s.bytes));
  // Check again after backup I/O; exclusive() serializes app writes, not external editors.
  for (const s of snapshots)
    if ((await discardSnapshot(at, s.path)).version !== s.version)
      throw new GitRefusal("stale", `${s.path} ha cambiado durante la copia; no se ha descartado.`);
  await write(at, ["restore", "--worktree", "--", ...files.map((f) => f.path)]);
  return recovery;
}

export type Hunk = { text: string; digest: string };
export type Hunks = { header: string[]; hunks: Hunk[]; hunkable: boolean };

const HEADER_ONLY =
  /^(new file mode|deleted file mode|old mode|new mode|similarity index|rename from|copy from|Binary files)/;

// One file's diff split into its header and its hunks. Only a plain content change can be
// staged a hunk at a time: a new, deleted, renamed or binary file, or a mode change, goes
// whole. The digest names a hunk's text, so a click on a diff that has moved on is refused.
export function splitHunks(diff: string): Hunks {
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const header: string[] = [];
  const bodies: string[][] = [];
  for (const line of lines) {
    if (line.startsWith("@@")) bodies.push([line]);
    else if (bodies.length) (bodies.at(-1) as string[]).push(line);
    else header.push(line);
  }
  const hunks = bodies.map((b) => {
    const text = b.join("\n");
    return { text, digest: new Bun.CryptoHasher("sha1").update(text).digest("hex") };
  });
  const plain = !header.some((l) => HEADER_ONLY.test(l));
  return { header, hunks, hunkable: plain && hunks.length > 0 };
}

// What the diff route adds for the client: which hunks can be acted on and their digests.
export function hunksOf(file: GitFile, diff: { diff: string; truncated: boolean }) {
  const parts = splitHunks(diff.diff);
  const hunkable = parts.hunkable && file.kind === "changed" && !diff.truncated;
  return { hunkable, hunks: hunkable ? parts.hunks.map((h) => h.digest) : [] };
}

// Stages one hunk of the worktree side, or takes one hunk of the staged side back, by
// applying it to the index alone. The hunk is read again here; the client only names it.
export async function applyHunk(
  at: Where,
  path: string,
  staged: boolean,
  index: number,
  digest: string,
) {
  const [file] = listed(await readStatus(at), [path], (f) =>
    staged ? isStaged(f) : isUnstaged(f),
  );
  const diff = await readDiff(at, file as GitFile, staged);
  const parts = splitHunks(diff.diff);
  if (!hunksOf(file as GitFile, diff).hunkable) {
    throw new GitRefusal("not_hunkable", "Este fichero se prepara entero, no por partes.");
  }
  const hunk = parts.hunks[index];
  if (!hunk || hunk.digest !== digest) {
    throw new GitRefusal(
      "stale",
      "El fichero ha cambiado desde que se mostró: actualiza la vista.",
    );
  }
  // whitespace=nowarn: the repo's apply.whitespace=fix must not rewrite what is staged.
  await write(at, ["apply", "--cached", "--whitespace=nowarn", ...(staged ? ["-R"] : []), "-"], {
    input: `${[...parts.header, hunk.text].join("\n")}\n`,
  });
}

export type CommitResult = { oid: string; summary: string };

// What is staged, with the message as written: the repo's hooks run, and nothing is signed
// for the user or added to the message.
export async function commitStaged(at: Where, message: string): Promise<CommitResult> {
  const s = await readStatus(at);
  noConflict(s.files);
  if (!s.files.some(isStaged)) {
    throw new GitRefusal("nothing_staged", "No hay nada preparado para el commit.");
  }
  try {
    await write(at, ["commit", "--cleanup=strip", "-F", "-"], {
      input: message,
      timeoutMs: COMMIT_TIMEOUT_MS,
    });
  } catch (err) {
    if (!(err instanceof GitError)) throw err;
    const words = err.message.replace(/^git exited with \d+: /, "");
    if (/tell me who you are|unable to auto-detect email/i.test(words)) {
      throw new GitRefusal(
        "no_identity",
        "git no sabe quién eres: configura user.name y user.email en este repo o en el global.",
      );
    }
    throw new GitRefusal("commit_failed", `El commit no se ha hecho: ${words}`);
  }
  const log = (
    await runGit(at.bin, at.cwd, ["log", "-1", "--format=%H%x00%s"], { env: at.env })
  ).out.trim();
  const [oid = "", summary = ""] = log.split("\0");
  return { oid, summary };
}

// git's words for a push the remote refused because it has commits the branch lacks; its
// error keeps only the last 300 characters, often just the hint. A "[remote rejected]" (a
// protected branch, a hook) is not one of them and stays git's own error.
const NOT_FAST_FORWARD =
  /\[rejected\]|non-fast-forward|\(fetch first\)|remote contains work|tip of your current branch is behind/;

export type PushResult = { branch: string; remote: string; upstreamSet: boolean; commits: number };

const gitOut = async (at: Where, args: string[], ok = [0]): Promise<GitResult> =>
  runGit(at.bin, at.cwd, args, { env: at.env, ok });

// Pushes the current branch to the branch it follows, named in full whatever push.default
// says. A branch with no upstream goes to its only remote (or origin) under its own name and
// starts following it. Never a force push: a rejected push says to bring the remote first.
export async function pushBranch(at: Where): Promise<PushResult> {
  const s = await readStatus(at);
  if (!s.branch) throw new GitRefusal("detached", "HEAD separado: no hay rama que subir.");
  const config = async (key: string) =>
    (await gitOut(at, ["config", "--get", `branch.${s.branch}.${key}`], [0, 1])).out.trim();
  let remote = s.upstream ? await config("remote") : "";
  const merge = s.upstream ? await config("merge") : "";
  if (remote === ".") {
    throw new GitRefusal("no_remote", `${s.branch} sigue una rama local, no un remoto.`);
  }
  if (!remote) {
    const remotes = (await gitOut(at, ["remote"])).out.split("\n").filter(Boolean);
    remote =
      remotes.length === 1 ? (remotes[0] as string) : remotes.includes("origin") ? "origin" : "";
  }
  if (!remote) throw new GitRefusal("no_remote", "Este repo no tiene un remoto al que subir.");
  const target = merge && s.upstream ? merge : `refs/heads/${s.branch}`;
  try {
    await write(at, ["push", ...(s.upstream ? [] : ["-u"]), remote, `HEAD:${target}`], {
      env: network(at.env),
      timeoutMs: FETCH_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof GitError && NOT_FAST_FORWARD.test(err.message)) {
      throw new GitRefusal(
        "behind",
        `El remoto tiene commits que ${s.branch} no tiene: avanza o mezcla primero; no se fuerza.`,
      );
    }
    throw err;
  }
  return {
    branch: s.branch,
    remote,
    upstreamSet: !s.upstream,
    commits: s.upstream ? (s.ahead ?? 0) : 0,
  };
}
