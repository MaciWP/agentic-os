import { readdir, realpath, stat } from "node:fs/promises";
import nodePath, { dirname, isAbsolute, join } from "node:path";
import type { Config } from "../../config.ts";
import { samePath } from "../../paths.ts";

// Browsing the host's folders one level at a time: folders only for a picker in the app,
// files too (and dot entries) for the code tile. It knows nothing about repos; a caller marks
// what it needs from `git`. ponytail: no timeout; add one if a mounted network volume hangs a
// listing.

export type FolderEntry = { name: string; path: string; kind: "folder"; git: boolean };
export type FileEntry = { name: string; path: string; kind: "file" };
export type Entry = FolderEntry | FileEntry;

export type Listing<E extends Entry = FolderEntry> = {
  path: string;
  // null at the root.
  parent: string | null;
  // The listed folder itself has a .git: a repo root or a worktree.
  git: boolean;
  entries: E[];
  truncated: boolean;
};

// Never listed, even with dot entries: what an editor hides by default.
const NEVER = new Set([".git", ".DS_Store"]);

export type Place = {
  id: "repos" | "home" | "envs" | "worktrees" | `drive-${string}`;
  label: string;
  path: string;
};

type FileErrorCode =
  | "not_absolute"
  | "not_found"
  | "not_a_folder"
  | "not_a_file"
  | "no_access"
  | "outside"
  // Writes (the code tile): the file changed since it was read, it cannot be saved as text,
  // or the text is past the cap.
  | "stale"
  | "not_editable"
  | "too_large";

export class FileError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 413,
    readonly code: FileErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const LIST_LIMIT = 2000;

const errno = (err: unknown) => (err as NodeJS.ErrnoException | null)?.code;

// macOS answers EPERM when its privacy settings keep a folder from this process.
export function readError(err: unknown, path: string, what = "la carpeta"): never {
  const code = errno(err);
  if (code === "ENOENT") throw new FileError(404, "not_found", `No existe ${what} ${path}.`);
  if (code === "ENOTDIR") throw new FileError(400, "not_a_folder", `${path} no es una carpeta.`);
  if (code === "EACCES" || code === "EPERM")
    throw new FileError(403, "no_access", `macOS no deja leer ${path}.`);
  throw err;
}

// What is at a path, following links; null when nothing readable is there.
const statOrNull = (path: string) => stat(path).catch(() => null);
const exists = async (path: string) => (await statOrNull(path)) !== null;
const isFolder = async (path: string) => (await statOrNull(path))?.isDirectory() ?? false;
const isFile = async (path: string) => (await statOrNull(path))?.isFile() ?? false;

// Folders first, then files; numbers in order, case ignored.
const byName = (a: Entry, b: Entry) =>
  a.kind !== b.kind
    ? a.kind === "folder"
      ? -1
      : 1
    : a.name.localeCompare(b.name, "es", { numeric: true, sensitivity: "base" });

type ListOptions = { limit?: number; files?: boolean; dotfiles?: boolean };

export function listFolders(path: string, options?: { limit?: number }): Promise<Listing>;
export function listFolders(
  path: string,
  options: ListOptions & { files: true },
): Promise<Listing<Entry>>;
export async function listFolders(
  path: string,
  { limit = LIST_LIMIT, files = false, dotfiles = false }: ListOptions = {},
): Promise<Listing<Entry>> {
  if (!isAbsolute(path))
    throw new FileError(400, "not_absolute", "La ruta tiene que ser absoluta.");
  const dir = await realpath(path).catch((err) => readError(err, path));
  if (!(await isFolder(dir)))
    throw new FileError(400, "not_a_folder", `${path} no es una carpeta.`);
  const dirents = await readdir(dir, { withFileTypes: true }).catch((err) => readError(err, path));
  const candidates = dirents.filter(
    (d) =>
      !NEVER.has(d.name) &&
      (dotfiles || !d.name.startsWith(".")) &&
      (d.isDirectory() || d.isSymbolicLink() || (files && d.isFile())),
  );
  const entries = (
    await Promise.all(
      candidates.map(async (d): Promise<Entry | null> => {
        const child = join(dir, d.name);
        const folder = d.isDirectory() || (d.isSymbolicLink() && (await isFolder(child)));
        if (!folder) {
          // A link to a file counts as one; a dangling link is left out.
          if (!files || (d.isSymbolicLink() && !(await isFile(child)))) return null;
          return { name: d.name, path: child, kind: "file" };
        }
        return {
          name: d.name,
          path: child,
          kind: "folder",
          git: await exists(join(child, ".git")),
        };
      }),
    )
  )
    .filter((e): e is Entry => e !== null)
    .sort(byName);
  return {
    path: dir,
    // A root (`/`, `D:\\`) is its own dirname.
    parent: dirname(dir) === dir ? null : dirname(dir),
    git: await exists(join(dir, ".git")),
    entries: entries.slice(0, limit),
    truncated: entries.length > limit,
  };
}

// The deepest folder that holds every given folder; null when only the root does.
export function commonParent(paths: string[], p: typeof nodePath = nodePath): string | null {
  if (paths.length === 0) return null;
  // The root (`/`, `D:\\`) is the first part, so folders on two drives share nothing.
  const split = paths.map((path) => {
    const { root } = p.parse(path);
    return [root, ...path.slice(root.length).split(p.sep).filter(Boolean)];
  });
  const first = split[0] ?? [];
  let n = 0;
  while (n < first.length && split.every((s) => s[n] === first[n])) n++;
  return n <= 1 ? null : p.join(...first.slice(0, n));
}

// Windows: every drive root that answers (C:, D:…), so a repo on any disk is reachable.
const DRIVES = [..."CDEFGHIJKLMNOPQRSTUVWXYZ"];
export const driveRoots = (platform = process.platform): Place[] =>
  platform === "win32"
    ? DRIVES.map((d) => ({ id: `drive-${d.toLowerCase()}`, label: `${d}:`, path: `${d}:\\` }))
    : [];

// Where a picker can jump: the folder that holds the configured repos, home, the envs and
// worktrees roots, and on Windows the drives. Each once, and only if it is a folder now.
export async function places(
  config: Config,
  home: string,
  platform = process.platform,
): Promise<Place[]> {
  const repos = commonParent(config.repos.map((r) => dirname(r.localPath)));
  const candidates: (Place | null)[] = [
    repos ? { id: "repos", label: "Repos", path: repos } : null,
    { id: "home", label: "Inicio", path: home },
    config.envs ? { id: "envs", label: "Entornos", path: config.envs.root } : null,
    config.worktrees ? { id: "worktrees", label: "Worktrees", path: config.worktrees.root } : null,
    ...driveRoots(platform),
  ];
  const out: Place[] = [];
  for (const p of candidates) {
    if (!p || out.some((o) => samePath(o.path, p.path)) || !(await isFolder(p.path))) continue;
    out.push(p);
  }
  return out;
}
