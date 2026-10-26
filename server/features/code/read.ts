import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { hasGitSegment, isInside } from "../../paths.ts";
import { FileError, listFolders, readError } from "../files/browse.ts";
import { GitError, runGit } from "../git/run.ts";

// What the code tile reads below a checkout: one folder at a time and one file at a time,
// never above the checkout. Saving is write.ts.

// git is optional: without it the tile still lists and reads, with no ignore marks.
export type CodeWhere = { bin: string | null; cwd: string; env: Record<string, string> };

export const READ_LIMIT = 1024 * 1024;
const SNIFF_BYTES = 8192;

// `rel` below the checkout as the client wrote it ("" is the checkout) and its real path.
// Refused before touching the disk when it climbs out (`..`, an absolute path), and after
// realpath when a link leads out, so nothing outside is read or even said to exist.
export async function confine(root: string, rel: string) {
  const base = await realpath(root).catch((err) => readError(err, root));
  const clean = posix.normalize(`/${rel}`).slice(1).replace(/\/$/, "");
  if (isAbsolute(rel) || !isInside(base, join(base, rel))) {
    throw new FileError(403, "outside", "La ruta sale del checkout.");
  }
  const path = await realpath(join(base, clean)).catch((err) => readError(err, clean, "la ruta"));
  if (!isInside(base, path)) throw new FileError(403, "outside", "La ruta sale del checkout.");
  return { base, rel: clean, path };
}

// The git work tree that holds `dir`, when it is the checkout's own or one below it: an env's
// root may sit inside some other repo, whose ignore rules are not the env's.
export async function repoTop({ bin, env }: CodeWhere, base: string, dir: string) {
  if (!bin) return null;
  try {
    const { out } = await runGit(bin, dir, ["rev-parse", "--show-toplevel"], { env });
    const top = await realpath(out.trim()).catch(() => null);
    return top && isInside(base, top) ? top : null;
  } catch (err) {
    if (err instanceof GitError) return null;
    throw err;
  }
}

export type CodeEntry = { name: string; path: string; kind: "folder" | "file"; ignored: boolean };
export type CodeListing = { dir: string; entries: CodeEntry[]; truncated: boolean };

// One folder: folders first, then files, dot entries too (.github, .claude matter here); what
// git ignores is marked, as an editor greys it, not hidden.
export async function listCode(where: CodeWhere, dir: string): Promise<CodeListing> {
  const { base, rel, path } = await confine(where.cwd, dir);
  const listing = await listFolders(path, { files: true, dotfiles: true });
  const ignored = await ignoredNames(where, base, path, listing.entries);
  return {
    dir: rel,
    entries: listing.entries.map((e) => ({
      name: e.name,
      path: rel ? `${rel}/${e.name}` : e.name,
      kind: e.kind,
      ignored: ignored.has(e.name),
    })),
    truncated: listing.truncated,
  };
}

async function ignoredNames(
  where: CodeWhere,
  base: string,
  dir: string,
  entries: { name: string; kind: "folder" | "file" }[],
): Promise<Set<string>> {
  if (!where.bin || entries.length === 0 || !(await repoTop(where, base, dir))) return new Set();
  // A folder goes with its slash, so a `name/` rule matches it. Exit 1: nothing is ignored.
  const input = entries.map((e) => (e.kind === "folder" ? `${e.name}/` : e.name)).join("\0");
  const { out } = await runGit(where.bin, dir, ["check-ignore", "--stdin", "-z"], {
    env: where.env,
    input,
    ok: [0, 1],
  });
  return new Set(
    out
      .split("\0")
      .filter(Boolean)
      .map((n) => n.replace(/\/$/, "")),
  );
}

// `version` is the file's ETag: an image's address carries it, so an edited image loads anew.
// `editable` is false for text that is not valid UTF-8 (saving would change bytes nobody
// touched) and for anything inside .git.
export type CodeFile =
  | {
      kind: "text";
      path: string;
      text: string;
      size: number;
      digest: string;
      version: string;
      editable: boolean;
    }
  | { kind: "binary" | "too_large"; path: string; size: number; version: string };

// A file below the checkout, by its size and its change time to the nanosecond: the version
// a poll asks about (a weak ETag) without reading the file again.
export type CodeStat = { rel: string; path: string; size: number; version: string };

export async function statCode(where: CodeWhere, rel: string): Promise<CodeStat> {
  const { rel: clean, path } = await confine(where.cwd, rel);
  const info = await stat(path, { bigint: true }).catch((err) =>
    readError(err, clean, "el fichero"),
  );
  if (!info.isFile()) throw new FileError(400, "not_a_file", `${clean} no es un fichero.`);
  return { rel: clean, path, size: Number(info.size), version: versionOf(info) };
}

export const versionOf = (info: { size: bigint; mtimeNs: bigint }) =>
  `W/"${info.size}-${info.mtimeNs}"`;

// A file's text, or why it has none: a NUL near the start is binary, past the cap too large.
export async function readCode(file: CodeStat): Promise<CodeFile> {
  const { rel: clean, path, version } = file;
  if (file.size > READ_LIMIT) return { kind: "too_large", path: clean, size: file.size, version };
  const bytes = await readFile(path).catch((err) => readError(err, clean, "el fichero"));
  if (binary(bytes)) {
    return { kind: "binary", path: clean, size: bytes.length, version };
  }
  const digest = new Bun.CryptoHasher("sha1").update(bytes).digest("hex");
  const text = utf8(bytes);
  return {
    kind: "text",
    path: clean,
    text: text ?? bytes.toString("utf8"),
    size: bytes.length,
    digest,
    version,
    editable: text !== null && !inGit(clean),
  };
}

// A NUL near the start: what git and editors take for a binary file.
export const binary = (bytes: Uint8Array) => bytes.subarray(0, SNIFF_BYTES).includes(0);

// A file's text when its bytes are valid UTF-8, a byte-order mark kept; null otherwise.
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export function utf8(bytes: Uint8Array): string | null {
  try {
    return strict.decode(bytes);
  } catch {
    return null;
  }
}

// git's own folder: the tile shows it when asked by path, never writes to it.
export const inGit = (rel: string) => hasGitSegment(rel);

// The checkout-relative path of `abs`, or null when it lies outside the checkout.
// Always with `/`, as the client and git spell it.
export const below = (base: string, abs: string) =>
  isInside(base, abs) ? relative(base, abs).split(sep).join("/") : null;
