import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// One run at a time across every session sharing this tree. The lock is a folder (mkdir is
// atomic) holding the owner's pid; a lock whose owner is gone is taken over. Waits up to
// `waitMs`, saying once who it waits for. Returns the release.
export async function lock(dir: string, what: string, waitMs = 30 * 60_000): Promise<() => void> {
  const pidFile = join(dir, "pid");
  const end = Date.now() + waitMs;
  let told = false;
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(pidFile, String(process.pid));
      return () => rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    let owner = Number.NaN;
    try {
      owner = Number(readFileSync(pidFile, "utf8"));
    } catch {}
    // A folder without a pid yet is a run that is just starting: wait for it like any other.
    if (Number.isInteger(owner) && owner > 0 && !alive(owner)) {
      rmSync(dir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > end) throw new Error(`${what}: still held by pid ${owner} after waiting`);
    if (!told) console.error(`${what}: waiting for the run of pid ${owner} to end…`);
    told = true;
    await Bun.sleep(2000);
  }
}
