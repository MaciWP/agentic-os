import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { isInside } from "../../paths.ts";
import { runGit } from "../git/run.ts";
import { CoordinationError } from "./store.ts";

const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;
const hash = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
type Entry = { path: string; hash: string; bytes: number };
// Reads the tree twice. A concurrent modification refuses preparation instead of calling a
// mixed tree reproducible. All participants later read this one saved, immutable tree.
export async function captureSnapshot(
  source: string,
  destination: string,
  env: Record<string, string>,
  git: string,
) {
  const root = await realpath(source);
  const command = (cwd: string, args: string[]) =>
    runGit(git, cwd, args, { env, maxBytes: 8 * 1024 * 1024 });
  const enumerate = async (cwd: string): Promise<string[]> => {
    const result = await command(cwd, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    if (result.truncated) throw new CoordinationError("snapshot_limit", "file inventory too large");
    const paths: string[] = [];
    for (const name of [...new Set(result.out.split("\0").filter(Boolean))]) {
      if (isAbsolute(name) || name.split("/").some((p) => p === ".." || p === ".git"))
        throw new CoordinationError("bad_path", name, 400);
      const file = join(cwd, name);
      const stat = await lstat(file).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return null;
        throw err;
      });
      if (!stat) continue; // A tracked deletion is part of the working tree.
      if (stat.isDirectory()) paths.push(...(await enumerate(file)));
      else paths.push(file);
    }
    return paths.sort();
  };
  const scan = async (copy: boolean) => {
    let total = 0;
    const files: Entry[] = [];
    const excluded: string[] = [];
    for (const path of await enumerate(root)) {
      const rel = relative(root, path);
      const target = await realpath(path);
      if (!isInside(root, target)) {
        excluded.push(rel);
        continue;
      }
      const info = await lstat(target);
      if (!info.isFile()) {
        excluded.push(rel);
        continue;
      }
      total += info.size;
      if (total > MAX_SNAPSHOT_BYTES)
        throw new CoordinationError("snapshot_limit", "snapshot exceeds 512 MiB");
      const bytes = await readFile(target);
      files.push({ path: rel, hash: hash(bytes), bytes: bytes.length });
      if (copy) {
        const out = join(destination, rel);
        await mkdir(dirname(out), { recursive: true, mode: 0o700 });
        await writeFile(out, bytes, { mode: 0o400 });
      }
    }
    return { files, excluded };
  };
  const revision = async () => ({
    head: (
      await command(root, ["rev-parse", "--verify", "HEAD"]).catch(() => ({ out: "unborn" }))
    ).out.trim(),
    diff: await command(root, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD"]).catch(
      () => command(root, ["diff", "--no-ext-diff", "--no-textconv", "--binary"]),
    ),
  });
  await mkdir(destination, { recursive: false, mode: 0o700 });
  const before = await revision();
  if (before.diff.truncated) throw new CoordinationError("snapshot_limit", "diff too large");
  const first = await scan(true);
  const second = await scan(false);
  const after = await revision();
  if (
    JSON.stringify(first) !== JSON.stringify(second) ||
    JSON.stringify(before) !== JSON.stringify(after)
  )
    throw new CoordinationError(
      "snapshot_changed",
      "checkout changed while copying; prepare again",
    );
  const manifest = { ...first, head: before.head, fingerprint: hash(JSON.stringify(first.files)) };
  await writeFile(join(dirname(destination), "manifest.json"), JSON.stringify(manifest), {
    mode: 0o600,
  });
  await writeFile(join(dirname(destination), "changes.patch"), before.diff.out, { mode: 0o600 });
  return manifest;
}
