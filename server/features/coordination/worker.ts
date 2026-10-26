import { log } from "../../log.ts";
import { killTree } from "../../run.ts";

// A pipe from the PTY host is the lifetime lease. EOF means the host is gone, even after
// SIGKILL: kill this isolated process group so a headless model cannot keep spending.
// Imported for its path too, making it part of the host's build fingerprint.
export const WORKER_ENTRY = import.meta.path;
if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (!argv.length) process.exit(2);
  const kill = () => {
    killTree(process.pid);
    if (process.platform === "win32") setTimeout(() => process.exit(1), 2_000);
  };
  void (async () => {
    for await (const _chunk of Bun.stdin.stream()) {
      /* Keep the lease open. */
    }
    kill();
  })();
  process.on("SIGTERM", kill);
  process.on("SIGINT", kill);
  try {
    const child = Bun.spawn(argv, { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    process.exit(await child.exited);
  } catch (err) {
    log("consultation").error("cannot start the harness", { err });
    process.exit(1);
  }
}
