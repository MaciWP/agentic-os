import type { Database } from "bun:sqlite";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { z } from "zod";
import type { CreateEnvRequest, RunEnvRequest } from "../../../shared/host-contract.ts";
import { clampSize, MAX_RUNNING } from "../../../shared/terminals.ts";
import { APP_ROOT, type HostConfig } from "../../config-host.ts";
import { errorMessage } from "../../error-message.ts";
import { log } from "../../log.ts";
import {
  conflict,
  envActionArgv,
  type Running,
  removeBlocker,
  runningCommands,
} from "../envs/actions.ts";
import { createArgv, listEnvs } from "../envs/provider.ts";
import { resolveAnyLocation } from "../projects/locations.ts";
import { Activity, type Clock, IDLE_BYTES, realClock } from "./activity.ts";
import {
  type Client,
  dropIfSlow,
  KILL_AFTER_MS,
  type LaunchSpec,
  Listeners,
  MAX_READ_LINES,
  type PasteMode,
  QUIET_MS,
  READ_LINES,
  type RestartResult,
  type ScreenText,
  type TerminalInfo,
  type TerminalKind,
  type Terminals,
  type WaitOptions,
  type WaitResult,
} from "./contract.ts";
import { prependPath } from "./env.ts";
import { argvFor, LaunchError, type Location, terminalEnv } from "./harness.ts";
import { LaunchRequests } from "./launch-requests.ts";
import { exitMessage, type Live, signalGroup, view, wake } from "./live.ts";
import { type LostTerminal, lostRow, ResumeRow } from "./lost.ts";
import { Screen, type Snapshot } from "./screen.ts";
import { Splitter } from "./splitter.ts";

export { MAX_RUNNING };
export const MAX_KEPT = 24;
// How long to wait for the PTY's last output after the process exits. Background jobs that
// keep the PTY open would otherwise hold the exit notice forever.
export const EOF_GRACE_MS = 1000;

export type { Client, LaunchSpec, TerminalInfo, TerminalKind, TerminalState } from "./contract.ts";
export { KILL_AFTER_MS, MAX_CLIENT_BUFFER } from "./contract.ts";

// The end and start of a bracketed paste; a pasted text must not close its own paste.
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
// The text of a paste can never end it early: the end marker is removed until none is left,
// since one pass over "\x1b[20\x1b[201~1~" leaves a new one.
const unmarked = (text: string) => {
  let out = text;
  while (out.includes(PASTE_END)) out = out.replaceAll(PASTE_END, "");
  return out;
};

// How long an ended terminal's row is kept.
const TERMINAL_KEEP_MS = 90 * 24 * 60 * 60 * 1000;

export class TerminalManager implements Terminals {
  private readonly live = new Map<string, Live>();
  private readonly listeners = new Listeners();
  // Read on every launch, so the host picks up config.json edits without a restart.
  private readonly config: () => HostConfig;
  // Set while the host shuts down: what it kills is lost, not ended (resumeLost).
  private closing = false;

  constructor(
    config: HostConfig | (() => HostConfig),
    private readonly db: Database,
    // The user's login environment, shared with the env provider's CLI.
    private readonly loadEnv: () => Promise<Record<string, string>>,
    private readonly clock: Clock = realClock,
  ) {
    this.config = typeof config === "function" ? config : () => config;
  }

  get env(): Promise<Record<string, string>> {
    return this.loadEnv();
  }

  // Called after every change the list shows: start, attach and detach, overflow, exit,
  // remove. The listener gets no payload; it reads the list again.
  subscribe(listener: () => void): () => void {
    return this.listeners.add(listener);
  }

  list(): TerminalInfo[] {
    return [...this.live.values()].map(view);
  }

  // Pids of the processes the app started directly (not their children).
  pids(): Set<number> {
    const out = new Set<number>();
    for (const l of this.live.values()) if (l.proc && l.proc.exitCode === null) out.add(l.proc.pid);
    return out;
  }

  get(id: string): TerminalInfo | undefined {
    const l = this.live.get(id);
    return l && view(l);
  }

  private launches?: LaunchRequests;
  create(spec: LaunchSpec): Promise<TerminalInfo> {
    this.launches ??= new LaunchRequests(this.db);
    return this.launches.run(spec, () => this.createOnce(spec));
  }
  launchStatus(id: string) {
    this.launches ??= new LaunchRequests(this.db);
    const result = this.launches.get(id);
    if (result?.terminal)
      result.terminal = this.get(result.terminal.id) ?? { ...result.terminal, state: "lost" };
    return result;
  }
  private async createOnce(spec: LaunchSpec): Promise<TerminalInfo> {
    // Everything that awaits comes first: from the count to the insert nothing yields, so
    // concurrent creates cannot all pass the limit.
    const env = await this.env;
    const config = this.config();
    const location = await resolveAnyLocation(config, env, spec.location);
    this.checkCapacity();
    const { prompt, model, effort, plan } = spec;
    const argv = argvFor(spec.harness, config, { prompt, model, effort, plan });
    const own = terminalEnv(spec.harness, config, model);
    return this.start(spec.harness, location, argv, { ...env, ...own }, spec);
  }

  // Reopens the agent sessions the last host lost, with permission bypass and their id, so
  // windows that still show it attach again. Nothing is typed: the agent waits for the user.
  // One that cannot come back keeps its row lost, with the reason.
  async resumeLost(lost: LostTerminal[]): Promise<void> {
    for (const raw of lost) {
      const row = ResumeRow.safeParse(raw);
      if (!row.success) continue;
      try {
        await this.relaunch(row.data, false);
      } catch (err) {
        const why = `not resumed: ${errorMessage(err)}`;
        this.db.query("UPDATE terminal_sessions SET error = ? WHERE id = ?").run(why, row.data.id);
        log("terminals").error(`${row.data.id} ${why}`);
      }
    }
  }

  // The user's «Reanudar» on a lost terminal: the same path, past the crash-loop cap, which
  // it starts again. Undefined when no such terminal is lost.
  async resume(id: string): Promise<TerminalInfo | undefined> {
    const raw = lostRow(this.db, id);
    if (!raw) return undefined;
    const row = ResumeRow.safeParse({ ...raw, resumes: 0 });
    if (!row.success) throw new LaunchError("this terminal has no session to resume");
    return (await this.relaunch(row.data, true)) ?? this.get(id);
  }

  // «Reiniciar»: stops a running agent and reopens it in the same row, so its id (and with it
  // AOS_AGENT_ID) stays. Undefined when there is no such terminal; refused, with nothing
  // stopped, when it is not running or has no session to come back to.
  async restart(id: string): Promise<RestartResult | undefined> {
    const l = this.live.get(id);
    if (!l) return undefined;
    if (l.info.state !== "running" || !l.proc) return { refused: "not_running" };
    const raw = lostRow(this.db, id, "running");
    const row = raw && ResumeRow.safeParse({ ...raw, resumes: 0 });
    if (!row?.success) return { refused: "no_session" };
    this.stop(id);
    // Row and state are both `exited` by the time the waiter wakes (see exited()).
    await new Promise<void>((resolve) => {
      const check = () => {
        if (l.info.state === "running") return;
        l.waiters.delete(check);
        resolve();
      };
      l.waiters.add(check);
      check();
    });
    try {
      // A concurrent restart that claimed the row first leaves this one the same terminal.
      await this.relaunch(row.data, true, "exited");
    } catch (err) {
      const why = `not restarted: ${errorMessage(err)}`;
      this.db.query("UPDATE terminal_sessions SET error = ? WHERE id = ?").run(why, id);
      log("terminals").error(`${id} ${why}`);
      throw err;
    }
    const terminal = this.get(id);
    return terminal ? { terminal } : undefined;
  }

  // Undefined when another call claimed the row first.
  private async relaunch(
    r: z.infer<typeof ResumeRow>,
    manual: boolean,
    from: "lost" | "exited" = "lost",
  ) {
    const env = await this.env;
    const config = this.config();
    const location = await resolveAnyLocation(config, env, r.location);
    this.checkCapacity();
    const argv = argvFor(r.harness, config, {
      ...(r.sessionId === null ? { pick: true } : { resume: r.sessionId }),
      model: r.model ?? undefined,
      effort: r.effort ?? undefined,
    });
    const own = terminalEnv(r.harness, config, r.model ?? undefined);
    // Claimed in the same statement that checks it is still in the source state: never resumed twice.
    const claim = this.db
      .query(
        `UPDATE terminal_sessions SET state = 'running', error = NULL, exit_code = NULL,
           resumes = CASE WHEN ? THEN 1 ELSE resumes + 1 END,
           signal = NULL, ended_at = NULL, cwd = ?, started_at = ?
         WHERE id = ? AND state = ?`,
      )
      .run(manual ? 1 : 0, location.cwd, new Date().toISOString(), r.id, from);
    if (claim.changes !== 1) return undefined;
    return this.start(
      r.harness,
      location,
      argv,
      { ...env, ...own },
      {
        id: r.id,
        ticket: r.ticket ?? undefined,
        name: r.name,
        model: r.model ?? undefined,
        effort: r.effort ?? undefined,
      },
    );
  }

  // Runs the env provider's create in a visible terminal. Whether it worked is decided later,
  // by the provider's list, when something launches in the new env.
  async createEnv(req: CreateEnvRequest, size: { cols?: number; rows?: number } = {}) {
    const env = await this.env;
    const cfg = this.config().envs;
    const argv = createArgv(cfg, req);
    // From here to the start nothing yields: two commands on one env cannot both pass.
    this.checkEnvCommand({ action: "create", env: req.name });
    const location = { id: "envs", label: "envs", cwd: cfg?.root ?? "" };
    return this.start(
      "env",
      location,
      argv,
      env,
      { ...size, ticket: req.branch },
      {
        env: req.name,
        action: "create",
      },
    );
  }

  // Runs one of the env provider's commands in a visible terminal at its root. The env must
  // be listed by the provider right now; the conflict rules are in envs/actions.ts.
  async runEnv(req: RunEnvRequest, size: { cols?: number; rows?: number } = {}) {
    const env = await this.env;
    const cfg = this.config().envs;
    const argv = envActionArgv(cfg, req);
    if (!cfg) throw new LaunchError("no env provider configured");
    const name = req.name ?? null;
    if (name !== null && !(await listEnvs(cfg, env)).some((e) => e.name === name))
      throw new LaunchError(`env ${name} is not listed by the env provider`);
    const root = await realpath(cfg.root).catch(() => {
      throw new LaunchError(`root ${cfg.root} does not exist`);
    });
    // From here to the start nothing yields.
    this.checkEnvCommand({ action: req.action, env: name });
    if (req.action === "remove" && name !== null) this.checkRemovable(join(root, name), name);
    const location = { id: "envs", label: "envs", cwd: root };
    return this.start("env", location, argv, env, size, { env: name, action: req.action });
  }

  private checkEnvCommand(next: Running) {
    this.checkCapacity();
    const why = conflict(next, runningCommands(this.infos()));
    if (why) throw new LaunchError(why);
  }

  private checkRemovable(dir: string, name: string) {
    const why = removeBlocker(this.infos(), dir, name);
    if (why) throw new LaunchError(why);
  }

  private infos() {
    return [...this.live.values()].map((l) => l.info);
  }

  private checkCapacity() {
    const running = [...this.live.values()].filter((l) => l.info.state === "running").length;
    if (running >= MAX_RUNNING) throw new LaunchError(`at most ${MAX_RUNNING} terminals`);
  }

  private start(
    kind: TerminalKind,
    location: Location,
    argv: string[],
    env: Record<string, string>,
    // `id` is a resumed terminal's own, its row already claimed.
    spec: {
      id?: string;
      ticket?: string;
      name?: string | null;
      model?: string;
      effort?: string;
      cols?: number;
      rows?: number;
    },
    command: Pick<TerminalInfo, "env" | "action"> = { env: null, action: null },
  ): TerminalInfo {
    const { cols, rows } = clampSize(spec.cols ?? 120, spec.rows ?? 32);
    const resumed = spec.id !== undefined;

    const info: TerminalInfo = {
      id: spec.id ?? crypto.randomUUID(),
      harness: kind,
      location: location.id,
      cwd: location.cwd,
      ticket: spec.ticket ?? null,
      name: spec.name ?? null,
      ...command,
      state: "running",
      exitCode: null,
      signal: null,
      error: null,
      overflowed: false,
      attached: false,
      activity: null,
      lastOutputAt: null,
      pid: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    let reachedEof = () => {};
    const eof = new Promise<void>((resolve) => {
      reachedEof = resolve;
    });
    const l: Live = {
      info,
      splitter: new Splitter(),
      eof,
      reachedEof,
      stopping: false,
      snapshotBytes: 0,
      waiters: new Set(),
      activity: new Activity(IDLE_BYTES[kind], () => this.changed(), this.clock),
    };
    l.screen = new Screen(
      cols,
      rows,
      (bytes) => this.forward(l, bytes),
      () => this.overflowed(l),
    );
    this.live.set(info.id, l);
    this.evictExited();

    try {
      l.proc = Bun.spawn(argv, {
        cwd: location.cwd,
        env: {
          ...prependPath(env, [join(APP_ROOT, "bin"), dirname(process.execPath)]),
          ...(["claude", "codex", "grok"].includes(kind) ? { AOS_AGENT_ID: info.id } : {}),
          AOS_URL: `http://localhost:${this.config().port}`,
        },
        terminal: {
          cols,
          rows,
          data: (_t, bytes) => {
            l.screen?.write(l.splitter.push(bytes));
            l.activity.output(bytes.length);
            wake(l);
          },
          exit: () => l.reachedEof(),
        },
      });
    } catch (err) {
      info.state = "failed";
      info.error = errorMessage(err);
      info.endedAt = new Date().toISOString();
      if (resumed)
        this.db
          .query(
            "UPDATE terminal_sessions SET state = 'failed', error = ?, ended_at = ? WHERE id = ?",
          )
          .run(info.error, info.endedAt, info.id);
      else this.insert(info, spec);
      this.changed();
      return this.get(info.id) as TerminalInfo;
    }
    if (!resumed) this.insert(info, spec);
    this.changed();
    void l.proc.exited.then(async (code) => {
      await Promise.race([l.eof, Bun.sleep(EOF_GRACE_MS)]);
      this.exited(l, code);
    });
    return this.get(info.id) as TerminalInfo;
  }

  // Sets the attached client. The switch happens in the screen queue, so the new client
  // gets the snapshot of everything before it and every byte after it, and the check for a
  // window already holding the terminal cannot race another attach.
  attach(id: string, client: Client, take = false): boolean {
    const l = this.live.get(id);
    if (!l?.screen) return false;
    l.screen.attach((snapshot: Snapshot) => {
      // A window that closed while waiting in the queue must not displace a healthy one.
      if (!client.isOpen()) return;
      const previous = l.client;
      if (previous && previous !== client && previous.isOpen() && !take) {
        client.send(JSON.stringify({ type: "busy" }));
        client.close(4409, "busy");
        return;
      }
      if (previous && previous !== client) {
        previous.send(JSON.stringify({ type: "takeover" }));
        previous.close(4001, "takeover");
      }
      l.client = client;
      // The program redraws for the new window; that is not it working.
      l.activity.mute();
      this.changed();
      const message = JSON.stringify({ type: "snapshot", ...snapshot });
      l.snapshotBytes = Buffer.byteLength(message);
      client.send(message);
      if (l.info.state !== "running") client.send(JSON.stringify(exitMessage(l.info)));
    });
    return true;
  }

  detach(id: string, client: Client): void {
    const l = this.live.get(id);
    if (l?.client !== client) return;
    l.client = undefined;
    this.changed();
  }

  input(id: string, client: Client, data: string): void {
    const l = this.live.get(id);
    if (l?.client !== client || l.info.state !== "running") return;
    // Keys typed echo back; the work they start lasts longer than the mute.
    l.activity.mute();
    l.proc?.terminal?.write(data);
  }

  resize(id: string, client: Client, cols: number, rows: number): void {
    const l = this.live.get(id);
    if (l?.client !== client || l.info.state !== "running") return;
    const size = clampSize(cols, rows);
    l.activity.mute();
    l.proc?.terminal?.resize(size.cols, size.rows);
    l.screen?.resize(size.cols, size.rows);
  }

  // The screen as text, without attaching: the open window keeps its place.
  read(id: string, lines = READ_LINES): Promise<ScreenText | undefined> {
    const l = this.live.get(id);
    const screen = l?.screen;
    if (!l || !screen) return Promise.resolve(undefined);
    const count = Math.min(Math.max(1, Math.floor(lines)), MAX_READ_LINES);
    const seq = screen.seq;
    return new Promise((resolve) =>
      screen.text(count, (text) => resolve({ text, seq, state: l.info.state })),
    );
  }

  // Input from an agent, not from the attached window. A paste is marked as one when the
  // program asked for it, so a multi-line text is not sent line by line; "only" sends nothing
  // when it did not.
  write(id: string, data: string, { paste = false }: { paste?: PasteMode } = {}): boolean {
    const l = this.live.get(id);
    if (!l?.proc?.terminal || l.info.state !== "running") return false;
    const marked = paste !== false && l.screen?.bracketedPaste === true;
    if (paste === "only" && !marked) return false;
    l.activity.mute();
    l.proc.terminal.write(marked ? `${PASTE_START}${unmarked(data)}${PASTE_END}` : data);
    return true;
  }

  // Resolves on exit, once output newer than `after` has been quiet for `quietMs`, or at
  // `timeoutMs`.
  waitFor(
    id: string,
    { after = 0, quietMs = QUIET_MS, timeoutMs = 30_000 }: WaitOptions,
  ): Promise<WaitResult | undefined> {
    const l = this.live.get(id);
    if (!l?.screen) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      let quiet: Timer | undefined;
      const done = (reason: WaitResult["reason"]) => {
        clearTimeout(quiet);
        clearTimeout(limit);
        l.waiters.delete(check);
        resolve({ reason, seq: l.screen?.seq ?? 0, state: l.info.state });
      };
      const check = () => {
        if (l.info.state !== "running") return done("exit");
        if ((l.screen?.seq ?? 0) <= after) return;
        clearTimeout(quiet);
        quiet = setTimeout(() => done("idle"), quietMs);
      };
      const limit = setTimeout(() => done("timeout"), timeoutMs);
      l.waiters.add(check);
      check();
    });
  }

  // SIGHUP to the whole process group, SIGKILL if it is still there after 5 s. The kill
  // goes to the group even when the leader has already exited: descendants that ignore
  // SIGHUP keep it alive, and a pid is not reused while its group still has members.
  stop(id: string): boolean {
    const l = this.live.get(id);
    if (!l?.proc || l.info.state !== "running") return false;
    l.stopping = true;
    signalGroup(l.proc.pid, "SIGHUP");
    l.killTimer ??= setTimeout(() => {
      if (l.proc) signalGroup(l.proc.pid, "SIGKILL");
    }, KILL_AFTER_MS);
    return true;
  }

  // The user's name for a terminal, running or ended; a change event only when it changes.
  rename(id: string, name: string | null): boolean {
    const l = this.live.get(id);
    if (!l) return false;
    if (l.info.name !== name) {
      l.info.name = name;
      // Kept with the row, so a resumed terminal has its name back.
      this.db.query("UPDATE terminal_sessions SET name = ? WHERE id = ?").run(name, id);
      this.changed();
    }
    return true;
  }

  // Frees an ended terminal and its screen.
  remove(id: string): boolean {
    const l = this.live.get(id);
    if (!l || l.info.state === "running") return false;
    l.client?.close(4002, "removed");
    l.activity.end();
    l.screen?.dispose();
    this.live.delete(id);
    this.changed();
    return true;
  }

  // Host shutdown: no terminal outlives the process that owns its PTY. Every group that
  // was running is killed, including those whose leader exited during the grace period.
  async stopAll(graceMs = 1000): Promise<void> {
    this.closing = true;
    const running = [...this.live.values()].filter((l) => l.info.state === "running" && l.proc);
    for (const l of running) signalGroup(l.proc?.pid ?? 0, "SIGHUP");
    await Promise.race([Promise.all(running.map((l) => l.proc?.exited)), Bun.sleep(graceMs)]);
    for (const l of running) signalGroup(l.proc?.pid ?? 0, "SIGKILL");
  }

  private forward(l: Live, bytes: Uint8Array): void {
    const client = l.client;
    if (!client) return;
    if (dropIfSlow(client, l.snapshotBytes)) {
      l.client = undefined;
      this.changed();
    } else client.send(bytes);
  }

  private overflowed(l: Live): void {
    l.info.overflowed = true;
    this.changed();
    const client = l.client;
    if (!client) return;
    l.client = undefined;
    client.send(JSON.stringify({ type: "overflow" }));
    client.close(4004, "overflow");
  }

  // Runs once the process has exited and its output is drained (or the grace ran out).
  private exited(l: Live, code: number): void {
    if (l.killTimer && !l.stopping) clearTimeout(l.killTimer);
    l.screen?.write(l.splitter.flush());
    const signal = l.proc?.signalCode ?? null;
    l.info.state = "exited";
    l.info.exitCode = signal ? null : code;
    l.info.signal = signal;
    l.info.endedAt = new Date().toISOString();
    l.activity.end();
    l.proc?.terminal?.close();
    // Killed by the host's own shutdown: its row stays running, so the next host marks it lost
    // and resumes it, as after a crash.
    if (!this.closing)
      this.db
        .query(
          "UPDATE terminal_sessions SET state = 'exited', exit_code = ?, signal = ?, ended_at = ? WHERE id = ?",
        )
        .run(l.info.exitCode, signal, l.info.endedAt, l.info.id);
    this.changed();
    wake(l);
    // Queued behind the last output, so the window sees the final screen before the notice.
    l.screen?.attach(() => l.client?.send(JSON.stringify(exitMessage(l.info))));
  }

  private changed(): void {
    this.listeners.notify();
  }

  private insert(info: TerminalInfo, spec: { model?: string; effort?: string }): void {
    // Rows of terminals that ended long ago go with each new one; Consumo names its sessions
    // from this table, so the window covers its months.
    this.db
      .query(
        "DELETE FROM terminal_sessions WHERE state IN ('exited', 'failed', 'lost') AND ended_at < ?",
      )
      .run(new Date(Date.now() - TERMINAL_KEEP_MS).toISOString());
    this.db
      .query(
        `INSERT INTO terminal_sessions (id, harness, location, cwd, ticket, state, error, started_at, ended_at, model, effort)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        info.id,
        info.harness,
        info.location,
        info.cwd,
        info.ticket,
        info.state,
        info.error,
        info.startedAt,
        info.endedAt,
        spec.model ?? null,
        spec.effort ?? null,
      );
  }

  private evictExited(): void {
    const ended = [...this.live.values()].filter((l) => l.info.state !== "running");
    for (const l of ended.slice(0, Math.max(0, this.live.size - MAX_KEPT))) this.remove(l.info.id);
  }
}
