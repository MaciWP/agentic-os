import { basename } from "node:path";

// The last lines of each log, for reading a machine's logs from another one: a worker's
// through the hub's proxy. Reads at most the file's last TAIL_BYTES, so a large log costs the
// same as a small one.
const TAIL_BYTES = 256 * 1024;

export async function tailLines(path: string, lines: number): Promise<string[] | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const text = await file.slice(Math.max(0, file.size - TAIL_BYTES)).text();
  const all = text.split(/\r?\n/);
  if (all.at(-1) === "") all.pop();
  // A cut at the start of the window leaves half a line.
  if (file.size > TAIL_BYTES) all.shift();
  return all.slice(-lines);
}

export async function logsText(files: string[], lines: number): Promise<string> {
  const parts = await Promise.all(
    files.map(async (path) => {
      const tail = await tailLines(path, lines);
      return [`===== ${basename(path)}`, ...(tail ?? ["(no existe)"])].join("\n");
    }),
  );
  return `${parts.join("\n\n")}\n`;
}
