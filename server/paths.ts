import nodePath from "node:path";

type PlatformPath = typeof nodePath;

// Whether `path` is `dir` or below it. Compares resolved paths, so `/a/bc` is not inside `/a/b`;
// symlinks are not followed: pass `realpath`s when they matter. A relative or empty path is
// never inside: `relative` would resolve it against the server's own folder. On Windows the
// comparison ignores case and accepts either separator, as the file system does.
export function isInside(dir: string, path: string, p: PlatformPath = nodePath): boolean {
  if (!p.isAbsolute(dir) || !p.isAbsolute(path)) return false;
  const rel = p.relative(dir, path);
  return rel !== ".." && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel);
}

// Whether two absolute paths name the same folder or file, compared as `isInside` does: on
// Windows `D:\Python\x` and `d:/PYTHON/x/` are one place.
export function samePath(a: string, b: string, p: PlatformPath = nodePath): boolean {
  return p.isAbsolute(a) && p.isAbsolute(b) && p.relative(a, b) === "";
}

// Whether a path names git's own folder anywhere. Case-insensitive, as APFS and NTFS are, and
// blind to what Windows drops or appends to a name (trailing dots and spaces, `:stream`).
export function hasGitSegment(path: string): boolean {
  return path.split(/[\\/]/).some(
    (s) =>
      s
        .split(":")[0]
        ?.replace(/[. ]+$/, "")
        .toLowerCase() === ".git",
  );
}
