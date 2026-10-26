import type { HostConfig } from "../../config-host.ts";
import { type Location, resolveLocation } from "../../launching.ts";
import { type Env, isEnvLocation, resolveEnvLocation } from "../envs/provider.ts";
import { isWorktreeLocation, resolveWorktreeLocation } from "./worktrees.ts";

// Every location kind, resolved by the server from its id. Launches leave `envs` out, so the
// env provider's list is read fresh; reads pass the cached one.
export async function resolveAnyLocation(
  config: HostConfig,
  env: Record<string, string>,
  id: string,
  envs?: Env[],
): Promise<Location> {
  if (isEnvLocation(id)) return resolveEnvLocation(config.envs, env, id, envs);
  if (isWorktreeLocation(id)) return resolveWorktreeLocation(config, env, id);
  return resolveLocation(config, id);
}
