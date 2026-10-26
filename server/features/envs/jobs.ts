import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ENV_NAME, isClean } from "../../../shared/envs.ts";
import { CreateEnvRequest } from "../../../shared/host-contract.ts";
import type { Config } from "../../config.ts";
import { errorMessage } from "../../error-message.ts";
import { KILL_AFTER_MS, LaunchError } from "../../launching.ts";
import { Listeners } from "../../listeners.ts";
import { log } from "../../log.ts";
import type { TerminalInfo, Terminals } from "../terminals/contract.ts";
import {
  conflict,
  envActionArgv,
  heldBy,
  type Running,
  removeBlocker,
  runningCommands,
} from "./actions.ts";
import { createArgv, listEnvs, removePreview } from "./provider.ts";

// Env commands the app runs itself, without a terminal (ADR 0005): the page shows their
// output as text while they run and their result when they end. The provider's prompts never
// show up: create and remove run with --yes, every other prompt reads a closed stdin as
// "no", and the provider refuses rather than guess. A remove that would lose work also runs
// with --force-dirty, and only when the user saw exactly those losses (`seen`).

// The tail is kept: the end of a create or an update holds its result.
export const OUTPUT_MAX = 256 * 1024;
// Finished jobs kept for the page; they live in the server's memory only.
export const KEEP_FINISHED = 20;
// ponytail: a create that hangs past this is killed; raise it if a real create takes longer.
export const JOB_TIMEOUT_MS = 30 * 60_000;

const Name = z.string().regex(ENV_NAME);
export const JobRequest = z.discriminatedUnion("action", [
  CreateEnvRequest.extend({ action: z.literal("create") }),
  z.object({ action: z.enum(["start", "stop", "update"]), name: Name }),
  // The env's name, typed by the user after seeing what the remove would throw away, the
  // fingerprint of the losses they saw (RemovePreview), when there were any, and the ids of
  // the open terminals they saw listed, which the remove closes first.
  z.object({
    action: z.literal("remove"),
    name: Name,
    confirm: z.string().max(100),
    seen: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    close: z.array(z.string().max(100)).max(50).optional(),
  }),
  z.object({ action: z.literal("doctor") }),
]);
export type JobRequest = z.infer<typeof JobRequest>;
export type JobAction = JobRequest["action"];

export type JobState = "running" | "ok" | "failed";
export type JobSummary = {
  id: string;
  action: JobAction;
  env: string | null;
  state: JobState;
  // Why it failed, in the provider's terms when it said nothing better than its exit code.
  error: string | null;
  startedAt: string;
  endedAt: string | null;
};
export type EnvJob = JobSummary & { output: string; truncated: boolean };

type Spawn = (
  argv: string[],
  opts: { cwd: string; env: Record<string, string> },
) => Bun.Subprocess<"ignore", "pipe", "pipe">;

const realSpawn: Spawn = (argv, { cwd, env }) =>
  Bun.spawn(argv, {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: JOB_TIMEOUT_MS,
  });

// Colours, cursor moves and title sets out; a carriage return redraws a line, so it ends one.
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what it strips
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it strips
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
export const plainText = (s: string) =>
  s.replace(ESCAPES, "").replace(/\r\n?/g, "\n").replace(CONTROLS, "");

// What a remove closes first, so an open terminal never makes the user hunt it down: the env's
// own logs, which only read it and lose their files with it, and the terminals inside it the
// user saw listed (`seen` ids). Anything else still running there blocks it (removeBlocker),
// so a terminal opened after the modal read the list is never closed unseen.
const closes = (t: TerminalInfo, dir: string, name: string, seen: Set<string>) =>
  t.state === "running" &&
  (t.harness === "env"
    ? t.env === name && t.action === "logs"
    : seen.has(t.id) && heldBy(t, dir, name));

async function closeHeld(terminals: Terminals, dir: string, name: string, ids: string[]) {
  const seen = new Set(ids);
  const held = (await terminals.list()).filter((t) => closes(t, dir, name, seen));
  if (held.length === 0) return;
  for (const t of held) await terminals.stop(t.id);
  // A stop asks first and kills after KILL_AFTER_MS; past that, removeBlocker says what is left.
  const until = Date.now() + KILL_AFTER_MS + 1000;
  while (Date.now() < until) {
    if (!(await terminals.list()).some((t) => closes(t, dir, name, seen))) return;
    await Bun.sleep(100);
  }
}

export type EnvJobsDeps = { config: Config; terminals: Terminals; spawn?: Spawn };

export class EnvJobs {
  private readonly jobs = new Map<string, EnvJob>();
  // Told when a job starts or ends: the server publishes it, and an end may change the envs.
  readonly changes = new Listeners<[EnvJob]>();

  constructor(private readonly deps: EnvJobsDeps) {}

  list(): JobSummary[] {
    return [...this.jobs.values()].reverse().map(({ output: _, truncated: __, ...s }) => s);
  }

  get(id: string): EnvJob | null {
    return this.jobs.get(id) ?? null;
  }

  // Why a command started elsewhere (a terminal) cannot run beside the jobs now running.
  blocker(next: Running): string | null {
    return conflict(next, this.running());
  }

  async start(req: JobRequest): Promise<JobSummary> {
    const { config, terminals } = this.deps;
    const cfg = config.envs;
    if (!cfg) throw new LaunchError("no env provider configured");
    const name = req.action === "doctor" ? null : req.name;
    let argv =
      req.action === "create"
        ? createArgv(cfg, req)
        : req.action === "remove"
          ? [...envActionArgv(cfg, req), "--yes"]
          : envActionArgv(cfg, { action: req.action, name: name ?? undefined });
    const env = await terminals.env;
    const root = await realpath(cfg.root).catch(() => {
      throw new LaunchError(`root ${cfg.root} does not exist`);
    });
    if (name !== null && req.action !== "create") {
      if (!(await listEnvs(cfg, env)).some((e) => e.name === name))
        throw new LaunchError(`env ${name} is not listed by the env provider`);
    }
    // The dry run again, right before the remove: work is forced away only when it is the very
    // work the user saw. The decision comes from this read, never from the client.
    if (req.action === "remove") {
      const now = await removePreview(cfg, env, req.name);
      if (!isClean(now)) {
        if (!req.seen) throw new LaunchError("hay cambios pendientes: revísalos antes de borrar");
        if (req.seen !== now.fingerprint)
          throw new LaunchError(
            "lo pendiente ha cambiado desde que lo revisaste; vuelve a revisarlo",
          );
        argv = [...argv, "--force-dirty"];
      }
      // A remove that cannot run closes nothing.
      const busy = this.conflictWith(req.action, name, await terminals.list());
      if (busy) throw new LaunchError(busy);
      await closeHeld(terminals, join(root, req.name), req.name, req.close ?? []);
    }
    const open = await terminals.list();
    // From here to the spawn nothing yields: two jobs on one env cannot both pass.
    const why = this.conflictWith(req.action, name, open);
    if (why) throw new LaunchError(why);
    if (req.action === "remove" && name !== null) {
      const busy = removeBlocker(open, join(root, name), name);
      if (busy) throw new LaunchError(busy);
    }
    let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      proc = (this.deps.spawn ?? realSpawn)(argv, { cwd: root, env });
    } catch (err) {
      throw new LaunchError(`cannot run ${cfg.bin}: ${errorMessage(err)}`);
    }
    const job: EnvJob = {
      id: crypto.randomUUID(),
      action: req.action,
      env: name,
      state: "running",
      error: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      output: "",
      truncated: false,
    };
    this.jobs.set(job.id, job);
    this.changes.notify(job);
    void this.follow(job, proc, req.action === "remove" ? join(root, req.name) : null);
    const { output: _, truncated: __, ...summary } = job;
    return summary;
  }

  private conflictWith(action: JobAction, env: string | null, open: TerminalInfo[]) {
    return conflict({ action, env }, [...runningCommands(open), ...this.running()]);
  }

  private running(): Running[] {
    return [...this.jobs.values()]
      .filter((j) => j.state === "running")
      .map((j) => ({ action: j.action, env: j.env }));
  }

  // `removed` is the folder of the env a remove job takes away.
  private async follow(
    job: EnvJob,
    proc: Bun.Subprocess<"ignore", "pipe", "pipe">,
    removed: string | null,
  ) {
    const append = (text: string) => {
      const all = job.output + plainText(text);
      job.truncated ||= all.length > OUTPUT_MAX;
      job.output = all.length > OUTPUT_MAX ? all.slice(-OUTPUT_MAX) : all;
    };
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) append(decoder.decode(chunk, { stream: true }));
      append(decoder.decode());
    };
    const [, , code] = await Promise.all([pump(proc.stdout), pump(proc.stderr), proc.exited]);
    const signal = proc.signalCode;
    job.state = code === 0 && !signal ? "ok" : "failed";
    job.error = signal ? `killed by ${signal}` : code === 0 ? null : `exited with ${code}`;
    job.endedAt = new Date().toISOString();
    if (removed && job.env && job.state === "ok") await this.forget(removed, job.env);
    this.prune();
    this.changes.notify(job);
  }

  // A removed env's ended terminals point at a folder that is gone: they leave the list too.
  private async forget(dir: string, name: string) {
    const { terminals } = this.deps;
    try {
      for (const t of await terminals.list())
        if (t.state !== "running" && heldBy(t, dir, name)) await terminals.remove(t.id);
    } catch (err) {
      log("envs").error(`${name} removed, its terminals kept: ${errorMessage(err)}`);
    }
  }

  private prune() {
    const finished = [...this.jobs.values()].filter((j) => j.state !== "running");
    for (const j of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED)))
      this.jobs.delete(j.id);
  }
}
