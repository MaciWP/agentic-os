import { randomBytes } from "node:crypto";
import { chmod, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { FileError, readError } from "../files/browse.ts";
import { binary, type CodeWhere, inGit, READ_LIMIT, statCode, utf8, versionOf } from "./read.ts";

// The code tile's save: one existing text file below the checkout, replaced whole, only when
// it is still the version the editor opened. An agent that wrote the file meanwhile wins: the
// tile shows the conflict instead of saving over it.

export type Saved = { version: string; size: number; digest: string };

// A checkout's writes go one at a time, in the order they came; a later one waits for the
// earlier to finish. The queue is joined before any await, so finding the file never reorders
// it, and one file reached by two names is still one queue.
const writing = new Map<string, Promise<unknown>>();

export async function writeCode(
  where: CodeWhere,
  rel: string,
  text: string,
  base: string,
): Promise<Saved> {
  const key = where.cwd;
  const before = writing.get(key) ?? Promise.resolve();
  const next = before.catch(() => {}).then(() => save(where, rel, text, base));
  writing.set(key, next);
  try {
    return await next;
  } finally {
    if (writing.get(key) === next) writing.delete(key);
  }
}

async function save(where: CodeWhere, rel: string, text: string, base: string): Promise<Saved> {
  // Read again inside the queue: the write before this one changed the version.
  const file = await statCode(where, rel);
  const root = await realpath(where.cwd).catch((err) => readError(err, where.cwd));
  if (inGit(file.rel) || inGit(relative(root, file.path))) {
    throw new FileError(403, "no_access", "Lo que hay dentro de .git no se edita aquí.");
  }
  const body = Buffer.from(text, "utf8");
  if (body.length > READ_LIMIT) {
    throw new FileError(413, "too_large", "El texto pasa de 1 MB: no se guarda desde la tile.");
  }
  if (file.version !== base) {
    throw new FileError(409, "stale", `${file.rel} ha cambiado en disco desde que se abrió.`);
  }
  if (file.size > READ_LIMIT) {
    throw new FileError(409, "not_editable", `${file.rel} pasa de 1 MB: no se edita aquí.`);
  }
  const old = await readFile(file.path).catch((err) => readError(err, file.rel, "el fichero"));
  if (binary(old) || utf8(old) === null) {
    throw new FileError(409, "not_editable", `${file.rel} no es texto UTF-8: no se edita aquí.`);
  }
  // Same folder, same permissions (a script stays executable), then rename: whoever reads the
  // file sees the old text or the new, never half. The version is the new file's own, taken
  // before the rename (which keeps it), so a write right after ours is never taken for ours.
  const { mode } = await stat(file.path);
  const tmp = join(dirname(file.path), `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, body, { flag: "wx" });
    await chmod(tmp, mode & 0o7777);
    const version = versionOf(await stat(tmp, { bigint: true }));
    await rename(tmp, file.path);
    const digest = new Bun.CryptoHasher("sha1").update(body).digest("hex");
    return { version, size: body.length, digest };
  } finally {
    await rm(tmp, { force: true });
  }
}
