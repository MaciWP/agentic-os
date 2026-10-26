import { mkdirSync, realpathSync, statSync } from "node:fs";
import { APP_ROOT, type HostConfig } from "./config-host.ts";

// What terminals, envs, projects and git share about starting something in a place. It sits
// outside every feature, so none of them imports another for it.

// A launch refused before anything started; routes answer 400.
export class LaunchError extends Error {}

// A stop sends SIGHUP and kills the process group this long after.
export const KILL_AFTER_MS = 5000;

export type Location = { id: string; label: string; cwd: string };

// The folder a terminal starts in when it is about no project (config `terminals.scratch`).
export const SCRATCH = "scratch";

// Every place a terminal may start in, resolved by the server. Requests carry only the id.
export function listLocations(config: HostConfig): Location[] {
  const out: Location[] = [{ id: "app", label: "Agentic OS", cwd: APP_ROOT }];
  for (const repo of config.repos) {
    out.push({ id: `repo:${repo.id}`, label: repo.id, cwd: repo.localPath });
  }
  out.push({ id: SCRATCH, label: "Carpeta libre", cwd: config.terminals.scratch });
  return out;
}

export function resolveLocation(config: HostConfig, id: string): Location {
  const location = listLocations(config).find((l) => l.id === id);
  if (!location) throw new LaunchError(`unknown location ${id}`);
  let cwd: string;
  try {
    if (id === SCRATCH) mkdirSync(location.cwd, { recursive: true });
    cwd = realpathSync(location.cwd);
  } catch {
    throw new LaunchError(`location ${id} does not exist`);
  }
  if (!statSync(cwd).isDirectory()) throw new LaunchError(`location ${id} is not a directory`);
  return { ...location, cwd };
}
