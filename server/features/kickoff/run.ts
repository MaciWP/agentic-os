import { lstat, mkdir, readdir, realpath, rm, rmdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { envState, ISSUE_KEY } from "../../../shared/envs.ts";
import { KICKOFF_PERMISSION } from "../../../shared/harness-capabilities.ts";
import { errorMessage } from "../../error-message.ts";
import { KICKOFF_KEEP_MS } from "../../retention.ts";
import type { EnvJob, EnvJobs, JobRequest } from "../envs/jobs.ts";
import type { Env } from "../envs/provider.ts";
import type { JiraClient } from "../jira/client.ts";
import { assignToMe, moveToStatus, type Ticket } from "../jira/issues.ts";
import type { MemoryStore } from "../memory/store.ts";
import type { HostInfo } from "../system/system.ts";
import { Listeners, type TerminalInfo, type Terminals } from "../terminals/contract.ts";
import { submit } from "../terminals/submit.ts";
import {
  buildContext,
  type ContextDeps,
  type KickoffMode,
  type TicketPull,
  ticketPulls,
} from "./context.ts";
import { kickoffPrompt, loadRecipe, type PrHead, reviewRoundPrompt } from "./prompt.ts";

// One click on a ticket, the whole chain on the server (ADR 0012): the context file, the env
// (created and started when needed, never stopping others), Claude in the env with the user's
// recipe and, for a review, where each checkout stands against its PR's commit, and for "start"
// the ticket moved and assigned in Jira. A failed step stops the chain: Claude never starts on
// top of it. A review clicked again while its Claude is open gets only what changed.

// A second start for a ticket whose kickoff is still running.
export class KickoffBusy extends Error {}
export const KickoffRequest = z.object({
  key: z.string().regex(ISSUE_KEY),
  mode: z.enum(["start", "review"]),
  // The PRs to review as the panel lists them; every PR of the ticket by others when absent.
  prs: z
    .array(z.object({ repo: z.string(), number: z.number().int().positive() }))
    .max(10)
    .optional(),
});
export type KickoffRequest = z.infer<typeof KickoffRequest>;

export type KickoffStep = "context" | "env" | "branch" | "services" | "agent" | "jira";
export type Kickoff = {
  key: string;
  mode: KickoffMode;
  step: KickoffStep;
  state: "running" | "ok" | "failed";
  error: string | null;
  // Something that went wrong after Claude started (Jira refused): the chain still ended ok.
  warning: string | null;
  // The env job of the current or last env step, shown in Entornos.
  job: string | null;
  // Claude's terminal; `reused` when one was already working on the ticket in its env.
  terminal: string | null;
  reused: boolean;
  // A review round: what changed was pasted to the open Claude. false with `reused` on a
  // review: nothing changed since its last round.
  sent: boolean;
  startedAt: string;
  endedAt: string | null;
};

export type KickoffDeps = Omit<ContextDeps, "jira" | "memory"> & {
  jira: Pick<JiraClient, "request" | "connection">;
  memory: ContextDeps["memory"] & Pick<MemoryStore, "get" | "create">;
  terminals: Pick<Terminals, "list" | "create" | "write">;
  jobs: Pick<EnvJobs, "start" | "get" | "changes">;
  // The env provider's list, read fresh at every step.
  listEnvs: () => Promise<Env[]>;
  hostInfo?: () => Promise<HostInfo | null>;
  dataDir: string;
};

// Finished kickoffs kept for the page; they live in the server's memory only.
// ponytail: a server restart mid-chain loses its state (its terminals live on); persist it
// when that bites.
export const KEEP_FINISHED = 20;

const SHA = /^[0-9a-f]{7,64}$/;
// The last lines of a job's output: where the provider says why it failed.
const tail = (output: string) => output.trim().split("\n").slice(-3).join(" · ");

export const envNameFor = (key: string, mode: KickoffMode) =>
  mode === "start" ? key.toLowerCase() : `rev-${key.toLowerCase()}`;

// The PRs to review: by others, chosen ones only when the panel sent a choice, one per
// repo, each in a repo the env provider knows.
export function reviewPulls(
  all: TicketPull[],
  chosen: KickoffRequest["prs"],
  providerRepos: string[],
): TicketPull[] {
  const pulls = all.filter(
    (p) =>
      !p.mine && (!chosen || chosen.some((c) => c.repo === p.repo.id && c.number === p.pr.number)),
  );
  if (pulls.length === 0) throw new Error("el ticket no tiene PRs abiertas de otros que revisar");
  const repos = pulls.map((p) => p.repo.id);
  const twice = repos.find((r, i) => repos.indexOf(r) !== i);
  if (twice) throw new Error(`hay dos PRs en ${twice}: elige una`);
  const unknown = repos.filter((r) => !providerRepos.includes(r));
  if (unknown.length > 0)
    throw new Error(`el proveedor de entornos no conoce ${unknown.join(", ")}`);
  return pulls;
}

export class Kickoffs {
  private readonly runs = new Map<string, Kickoff>();
  // Told on every step: the server publishes it.
  readonly changes = new Listeners();

  constructor(private readonly deps: KickoffDeps) {}

  list(): Kickoff[] {
    return [...this.runs.values()].reverse().map((r) => ({ ...r }));
  }

  // Answers at once; the steps show through `changes`. One chain per ticket at a time.
  start(req: KickoffRequest): Kickoff {
    if (this.runs.get(req.key)?.state === "running")
      throw new KickoffBusy(`${req.key} ya está arrancando`);
    const run: Kickoff = {
      key: req.key,
      mode: req.mode,
      step: "context",
      state: "running",
      error: null,
      warning: null,
      job: null,
      terminal: null,
      reused: false,
      sent: false,
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    this.runs.delete(req.key);
    this.runs.set(req.key, run);
    this.prune();
    this.changes.notify();
    void this.chain(run, req).then(
      () => this.end(run, null),
      (err) => this.end(run, errorMessage(err)),
    );
    return { ...run };
  }

  private end(run: Kickoff, error: string | null) {
    run.state = error === null ? "ok" : "failed";
    run.error = error;
    run.endedAt = new Date().toISOString();
    this.changes.notify();
  }

  private step(run: Kickoff, step: KickoffStep) {
    run.step = step;
    this.changes.notify();
  }

  private async chain(run: Kickoff, { key, mode, prs }: KickoffRequest) {
    const d = this.deps;
    const cfg = d.config.envs;
    if (!cfg) throw new Error("no hay proveedor de entornos configurado");
    const name = envNameFor(key, mode);
    const inEnv = (t: TerminalInfo) =>
      t.location === `env:${name}` || t.location.startsWith(`env:${name}/`);
    const working = (await d.terminals.list()).find(
      (t) => t.harness === "claude" && t.ticket === key && t.state === "running" && inEnv(t),
    );
    if (working && mode === "start") {
      run.terminal = working.id;
      run.reused = true;
      return;
    }
    // An old host builds the old argv: no plan mode, and env commands that still ask.
    if (!working && (await d.hostInfo?.())?.stale)
      throw new Error(
        "el host de terminales es de una versión anterior: reinícialo con ~/Applications/start-agentic-os.command",
      );

    // A review needs its PRs; a start only shows them, so a failed read stays in the context.
    const pulls =
      mode === "start"
        ? await ticketPulls(d, key).catch((err: unknown) => err as Error)
        : reviewPulls(await ticketPulls(d, key), prs, cfg.repos);
    const { text, ticket } = await buildContext(d, key, mode, pulls);
    const reviewed = pulls instanceof Error ? [] : pulls;
    const contextPath = join(d.dataDir, "kickoff", key, `${mode}.md`);
    // The last round's time: when its context file was written.
    const lastRound = await stat(contextPath).then(
      (s) => s.mtime,
      () => null,
    );
    await mkdir(dirname(contextPath), { recursive: true });
    await Bun.write(contextPath, text);
    await pruneContexts(join(d.dataDir, "kickoff"), Date.now());
    const root = await realpath(cfg.root);

    if (working) {
      this.step(run, "agent");
      run.terminal = working.id;
      run.reused = true;
      const heads = await this.prHeads(join(root, name), reviewed);
      const since = lastRound ?? new Date(working.startedAt);
      const newComments = reviewed
        .flatMap((p) => p.comments)
        .filter((c) => Date.parse(c.created) > since.getTime()).length;
      if (heads.every((h) => h.at === h.sha) && newComments === 0) return;
      if (working.agent?.state !== "needs_you" || working.agent.asks)
        throw new Error("Claude está ocupado en esta revisión: vuelve a pulsar cuando acabe");
      await submit(
        d.terminals,
        working.id,
        reviewRoundPrompt(key, contextPath, heads, since.toISOString(), newComments),
      );
      run.sent = true;
      return;
    }

    this.step(run, "env");
    // Every env holds every repo the provider offers: the proxy serves an env, and so gives it
    // its URLs, only with both frontend and backend. A review puts its PRs' repos on their own
    // branches.
    if (!(await this.find(name)))
      await this.job(run, {
        action: "create",
        name,
        repos: cfg.repos,
        branch: key,
        ...(mode === "review" && {
          branches: Object.fromEntries(reviewed.map((p) => [p.repo.id, p.pr.head])),
        }),
      });
    let env = await this.listed(name);
    if (env.problem) throw new Error(`entorno ${name}: ${env.problem}`);

    let heads: PrHead[] = [];
    if (mode === "review") {
      this.step(run, "branch");
      heads = await this.prHeads(join(root, name), reviewed);
    }

    this.step(run, "services");
    if (envState(env.repos) !== "up") {
      await this.job(run, { action: "start", name });
      env = await this.listed(name);
      const state = envState(env.repos);
      if (state === "partial" || state === "down")
        throw new Error(
          `servicios a medias en ${name}: ${env.repos.map((r) => `${r.repo} ${r.servers ?? "?"}`).join(", ")}`,
        );
    }

    this.step(run, "agent");
    const recipe = await loadRecipe(d.memory, mode);
    const prompt = kickoffPrompt(
      key,
      mode,
      ticket.url,
      { name, cwd: join(root, name), url: env.url, repos: env.repos },
      contextPath,
      recipe,
      heads,
    );
    const claude = await d.terminals.create({
      harness: "claude",
      location: `env:${name}`,
      ticket: key,
      prompt,
      plan: KICKOFF_PERMISSION[mode] === "plan",
    });
    run.terminal = claude.id;

    if (mode === "start") {
      this.step(run, "jira");
      run.warning = await this.claim(ticket).then(
        () => null,
        (err) => `Jira: ${errorMessage(err)}`,
      );
    }
  }

  // The env as the provider lists it now.
  private async find(name: string) {
    return (await this.deps.listEnvs()).find((e) => e.name === name);
  }

  private async listed(name: string): Promise<Env> {
    const env = await this.find(name);
    if (!env) throw new Error(`el proveedor de entornos no lista ${name}`);
    return env;
  }

  // Runs an env command as a job and waits for its end; anything but ok stops the chain.
  private async job(run: Kickoff, req: JobRequest) {
    const { jobs } = this.deps;
    const started = await jobs.start(req);
    run.job = started.id;
    this.changes.notify();
    const done = await new Promise<EnvJob | null>((resolve) => {
      const check = () => {
        const job = jobs.get(started.id);
        if (job?.state === "running") return;
        off();
        resolve(job);
      };
      const off = jobs.changes.add(check);
      check();
    });
    if (done?.state !== "ok")
      throw new Error(
        `${req.action} falló (${done?.error ?? "sin resultado"}): ${tail(done?.output ?? "")}`,
      );
  }

  // Where each review checkout stands against its PR's commit as GitHub has it now (not a
  // branch of the same name, which a fork's PR would not be). Claude brings a checkout that is
  // behind to the PR's commit; the app never moves it.
  private async prHeads(envDir: string, pulls: TicketPull[]): Promise<PrHead[]> {
    return Promise.all(
      pulls.map(async ({ repo, pr }) => {
        if (!SHA.test(pr.headSha))
          throw new Error(`GitHub no da un commit válido para la PR #${pr.number}`);
        const at = (await this.deps.git(join(envDir, repo.name), ["rev-parse", "HEAD"])).trim();
        return { repo: repo.name, pr: pr.number, at, sha: pr.headSha };
      }),
    );
  }

  // "Start" takes the ticket: out of the default board's first column into its second, and
  // to the user when nobody has it.
  private async claim(ticket: Ticket) {
    const [todo, next] = this.deps.config.jira?.boards[0]?.columns ?? [];
    const to = next?.statuses[0];
    if (todo?.statuses.includes(ticket.status.id) && to)
      await moveToStatus(this.deps.jira, ticket.key, to);
    if (!ticket.assignee) await assignToMe(this.deps.jira, ticket.key);
  }

  private prune() {
    const finished = [...this.runs.values()].filter((r) => r.state !== "running");
    for (const r of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED)))
      this.runs.delete(r.key);
  }
}

// Context files older than KICKOFF_KEEP_MS leave, and the ticket folders they empty. Only
// folders named by a ticket key are the kickoff's; a failed prune never fails the round.
async function pruneContexts(root: string, now: number) {
  for (const key of await readdir(root).catch(() => [])) {
    const dir = join(root, key);
    // A link is not followed: what it points to is not the kickoff's.
    if (!ISSUE_KEY.test(key) || !(await lstat(dir).catch(() => null))?.isDirectory()) continue;
    for (const name of await readdir(dir).catch(() => [])) {
      const s = await lstat(join(dir, name)).catch(() => null);
      if (s?.isFile() && now - s.mtimeMs > KICKOFF_KEEP_MS)
        await rm(join(dir, name), { force: true }).catch(() => {});
    }
    await rmdir(dir).catch(() => {});
  }
}
