import type { Deps } from "./deps.ts";
import { type Env, isEnvLocation } from "./features/envs/provider.ts";
import type { resolveAnyLocation } from "./features/projects/locations.ts";
import type { EnvCache } from "./features/projects/routes.ts";

// Where a location id points and what the env provider lists are the projects feature's
// logic; the app passes them in, so a feature that reads a checkout (git, code) never imports
// projects (which imports git).
export type Places = { envs: EnvCache; locate: typeof resolveAnyLocation };

// Every location resolves on the server from its id, as for a launch; env ones against the
// cached env list, since a click per file cannot wait for the provider. A client never sends
// a path to read from: only the id and, below it, a relative path.
export function placeResolver(
  { config, terminals }: Pick<Deps, "config" | "terminals">,
  places: Places,
) {
  const cachedEnvs = async (): Promise<Env[]> =>
    config.envs ? (await places.envs.get().catch(() => ({ envs: [] as Env[] }))).envs : [];
  const place = async (id: string) => {
    const env = await terminals.env;
    const envs = isEnvLocation(id) ? await cachedEnvs() : undefined;
    const location = await places.locate(config, env, id, envs);
    return { cwd: location.cwd, env };
  };
  return { place, cachedEnvs };
}
