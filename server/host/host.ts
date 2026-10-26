import { readFileSync, rmSync, statSync } from "node:fs";
import { type HostConfig, loadHostConfig } from "../config-host.ts";
import { errorMessage } from "../error-message.ts";
import { LaunchError } from "../features/terminals/harness.ts";

// Pieces of the PTY host process that are tested on their own; main.ts wires them.

// Removes a file only while it still names this process, so a successor's is kept.
export function removeIfOwn(path: string, owns: (text: string) => boolean): void {
  try {
    if (owns(readFileSync(path, "utf8"))) rmSync(path, { force: true });
  } catch {
    // Already gone.
  }
}

const mtime = (path: string) => statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0;

// config.json as of the last launch: re-read when it changes, so launches use the current
// binaries, locations and env provider without restarting the host. A broken edit fails
// the launch with the parse error and keeps nothing stale.
export function liveConfig(path: string, load = loadHostConfig): () => HostConfig {
  let config = load(path);
  let seen = mtime(path);
  return () => {
    const now = mtime(path);
    if (now === seen) return config;
    try {
      config = load(path);
    } catch (err) {
      throw new LaunchError(errorMessage(err));
    }
    seen = now;
    return config;
  };
}

// Calls onIdle once nothing has kept the host busy for idleMs.
export function idleWatch(busy: () => boolean, idleMs: number, onIdle: () => void): Timer {
  let idleSince = Date.now();
  const timer = setInterval(
    () => {
      if (busy()) idleSince = Date.now();
      else if (Date.now() - idleSince >= idleMs) {
        clearInterval(timer);
        onIdle();
      }
    },
    Math.min(10_000, Math.max(10, idleMs / 3)),
  );
  return timer;
}
