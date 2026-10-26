import { join, relative } from "node:path";
import { ENV_NAME, type EnvAction } from "../../../shared/envs.ts";
import type { RunEnvRequest, TerminalRecord } from "../../../shared/host-contract.ts";
import type { HostConfig } from "../../config-host.ts";
import { LaunchError } from "../../launching.ts";
import { isInside } from "../../paths.ts";

// Who an env command can disturb:
// - read: only reads, never conflicts;
// - tool: the provider's own tooling, conflicts only with itself;
// - env: changes one env.
export type Scope = "read" | "tool" | "env";

type Action = {
  // The arguments after the binary; `name` is the env, already validated.
  args: (name: string) => string[];
  scope: Scope;
  // Acts on one env, so it needs its name.
  needsEnv: boolean;
};

// Every command the app runs on the env provider, each with a fixed argv. Remove runs with
// --yes only from a job, after the user saw what it would discard and typed the env's name;
// jobs.ts adds --force-dirty only when the losses the provider reports right then are the
// ones the user saw. Never --force.
const ACTIONS = {
  // --yes: never asks which other envs to stop, and stops none.
  start: { args: (n) => ["start", n, "--yes"], scope: "env", needsEnv: true },
  stop: { args: (n) => ["stop", n], scope: "env", needsEnv: true },
  update: { args: (n) => ["update", n], scope: "env", needsEnv: true },
  remove: { args: (n) => ["remove", n], scope: "env", needsEnv: true },
  logs: { args: (n) => ["logs", n, "--follow"], scope: "read", needsEnv: true },
  doctor: { args: () => ["doctor"], scope: "tool", needsEnv: false },
} satisfies Record<EnvAction, Action>;

// A running env command, as the conflict rules see it. `create` changes one env too.
export type Running = { action: EnvAction | "create"; env: string | null };

const scopeOf = (action: EnvAction | "create"): Scope =>
  action === "create" ? "env" : ACTIONS[action].scope;

type Run = Pick<TerminalRecord, "id" | "harness" | "state" | "env" | "action" | "cwd" | "name">;

// The env commands running in terminals, as the conflict rules see them.
export const runningCommands = (terminals: Run[]): Running[] =>
  terminals
    .filter((t) => t.harness === "env" && t.state === "running" && t.action)
    .map((t) => ({ action: t.action as Running["action"], env: t.env }));

// The terminals an env holds: its own commands and any terminal opened inside its folder.
// `dir` is the env's real path.
export const heldBy = (t: Run, dir: string, name: string) =>
  t.harness === "env" ? t.env === name : isInside(dir, t.cwd);

const labelOf = (t: Run) => t.name ?? t.harness;
const folderOf = (t: Run, dir: string, name: string) => join(name, relative(dir, t.cwd));

// A terminal open inside an env, as the remove modal lists it: a remove closes it.
export type HeldTerminal = { id: string; name: string; folder: string };

// The terminals running inside the env's folder, not counting the env's own commands.
export const heldTerminals = (terminals: Run[], dir: string, name: string): HeldTerminal[] =>
  terminals
    .filter((t) => t.state === "running" && t.harness !== "env" && heldBy(t, dir, name))
    .map((t) => ({ id: t.id, name: labelOf(t), folder: folderOf(t, dir, name) }));

// A removed env takes its folder with it: nothing may still run inside it, not even a
// command that only reads the env, like its logs.
export function removeBlocker(terminals: Run[], dir: string, name: string): string | null {
  for (const t of terminals) {
    if (t.state !== "running" || !heldBy(t, dir, name)) continue;
    if (t.harness === "env") return `env ${name} still runs ${t.action ?? "a command"}`;
    return `la terminal «${labelOf(t)}» sigue abierta en ${folderOf(t, dir, name)}: párala antes de borrar`;
  }
  return null;
}

// Why `next` cannot start while `running` runs, or null when both can.
export function conflict(next: Running, running: Running[]): string | null {
  const scope = scopeOf(next.action);
  if (scope === "read") return null;
  for (const r of running) {
    const other = scopeOf(r.action);
    if (other === "read") continue;
    if (scope === "tool" || other === "tool") {
      if (r.action === next.action) return `${next.action} is already running`;
      continue;
    }
    if (r.env === next.env) return `env ${next.env} is busy with ${r.action}`;
  }
  return null;
}

// The argv for one action, every element checked on its own; nothing reaches a shell.
export function envActionArgv(cfg: HostConfig["envs"], req: RunEnvRequest): string[] {
  if (!cfg) throw new LaunchError("no env provider configured");
  const action = ACTIONS[req.action];
  if (!action) throw new LaunchError(`unknown env action ${req.action}`);
  const name = action.needsEnv ? (req.name ?? "") : "";
  if (action.needsEnv && !ENV_NAME.test(name)) throw new LaunchError("choose a valid env");
  if (!action.needsEnv && req.name !== undefined)
    throw new LaunchError(`${req.action} acts on every env, not on one`);
  if (req.action === "remove" && req.confirm !== name)
    throw new LaunchError(`type ${name} to confirm remove`);
  return [cfg.bin, ...action.args(name)];
}

export const needsEnv = (action: EnvAction) => ACTIONS[action].needsEnv;
