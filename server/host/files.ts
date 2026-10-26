import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HostFile } from "../../shared/host-contract.ts";
import { commandLine } from "../run.ts";

// A host as the server found it: `stale` when it runs older code, kept for its terminals.
export type FoundHost = HostFile & { stale?: boolean };

export const hostPaths = (dataDir: string) => ({
  // Where the running host listens and its token; mode 0600, rewritten on every host start.
  file: join(dataDir, "pty-host.json"),
  // Held for the host's whole life: one host per data dir.
  lock: join(dataDir, "pty-host.lock"),
  log: join(dataDir, "pty-host.log"),
});

export function readHostFile(path: string): HostFile | undefined {
  try {
    const parsed = HostFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

// Written beside and renamed, so a reader never sees half a file or a wider mode.
export function writeHostFile(path: string, info: HostFile): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
  renameSync(tmp, path);
}

// A pid in the lock file only counts while it is still a PTY host: after a reboot the
// number can belong to anything.
export async function isHostPid(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return (await commandLine(pid)).includes("host/main.ts");
}
