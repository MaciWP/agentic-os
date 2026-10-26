import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { log } from "./log.ts";

// A JSON file the server keeps under data/. Missing is null; a file that is not valid JSON or
// not what the schema says throws, so the caller decides what a broken file means.
export const readJson = <T>(path: string, schema: z.ZodType<T>): T | null => {
  try {
    return schema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
};

// Written beside and renamed, so a reader never sees half a file; only the user reads it.
export const writeJson = (path: string, value: unknown) => {
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
};

// A copy of what the server last read from a provider, with when it was read, kept so a
// restarted server answers at once (the shape `cached` takes as `initial`). Losing it costs one
// slow read: a missing or broken file is no copy, and a failed write leaves a line and the old
// copy. A value equal to the last one written is not written again.
export function fileCopy<T>(path: string, schema: z.ZodType<T>) {
  const copyLog = log("copy");
  const file = z.object({ at: z.number(), value: schema });
  let written = "";
  return {
    read(): { at: number; value: T } | undefined {
      try {
        const copy = readJson(path, file) ?? undefined;
        if (copy) written = JSON.stringify(copy.value);
        return copy;
      } catch (err) {
        copyLog.warn("unreadable, ignored", { path, error: err });
        return undefined;
      }
    },
    write(value: T, at = Date.now()) {
      const text = JSON.stringify(value);
      if (text === written) return;
      try {
        writeJson(path, { at, value });
        written = text;
      } catch (err) {
        copyLog.warn("not written", { path, error: err });
      }
    },
  };
}
export type FileCopy<T> = ReturnType<typeof fileCopy<T>>;
