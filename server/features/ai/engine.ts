// The local model for Claude terminals: llama-server on loopback, started by the first request
// or «Encender», stopped after idle minutes, by «Apagar», or when game mode turns on, so the GPU
// is only held while someone uses it. Only a process this server started is ever stopped: a
// leftover of ours (its pid file, our binary and port in its command line) is ended before a
// new start, never anything else on the port.
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { LOCAL_MODEL } from "../../../shared/harness-capabilities.ts";
import type { HostConfig } from "../../config-host.ts";
import { errorMessage } from "../../error-message.ts";
import { log } from "../../log.ts";
import { DROP } from "../../machines.ts";
import { commandLine, killTree } from "../../run.ts";
import type { Timer } from "../system/keep-awake.ts";

export type EngineConfig = NonNullable<NonNullable<HostConfig["ai"]>["engine"]>;

export type AiState = {
  state: "off" | "starting" | "ready" | "failed";
  gameMode: boolean;
  // Requests answering right now; the engine serves one at a time, the rest wait their turn.
  inFlight: number;
  idleMinutes: number;
  detail: string | null;
};

export class AiError extends Error {
  constructor(
    readonly code: "ai_game_mode" | "ai_unavailable",
    message: string,
  ) {
    super(message);
  }
}

export type EngineProcess = {
  pid: number;
  exited: Promise<number>;
  stderr: ReadableStream<Uint8Array>;
  kill(): void;
};
export type EngineSpawn = (argv: string[]) => EngineProcess;
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export type EngineDeps = {
  dataDir: string;
  spawn?: EngineSpawn;
  fetch?: Fetch;
  timer?: Timer;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  commandLine?: (pid: number) => Promise<string>;
  killTree?: (pid: number) => void;
  alive?: (pid: number) => boolean;
  // A 27B model with its drafter loads in about 9 s from an NVMe disk.
  startMs?: number;
};

export const aiPaths = (dataDir: string) => ({
  pid: join(dataDir, "ai-engine.json"),
  log: join(dataDir, "ai-engine.log"),
  mode: join(dataDir, "ai-mode.json"),
});

const PidFile = z.object({ pid: z.number().int().positive() });
const ModeFile = z.object({ gameMode: z.boolean() });
const START_MS = 180_000;
const POLL_MS = 500;
const HEALTH_MS = 2_000;

// The flags measured in the 2026-10-11 trial. One slot: the MTP
// drafter only loads with one, and requests queue for it. No prompt logging flag.
export function engineArgv(cfg: EngineConfig): string[] {
  return [
    cfg.bin,
    "-m",
    cfg.model,
    ...(cfg.draft ? ["-md", cfg.draft, "-ngld", "99", "--spec-draft-n-max", "8"] : []),
    ...["-ngl", "99", "-c", String(cfg.contextTokens), "-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0"],
    ...["-np", "1", "--host", "127.0.0.1", "--port", String(cfg.port), "--alias", LOCAL_MODEL],
    ...["--temp", "0.6", "--top-p", "0.95", "--top-k", "20", "--jinja", "--metrics"],
    ...(cfg.template ? ["--chat-template-file", cfg.template] : []),
    ...(cfg.reasoningBudget >= 0 ? ["--reasoning-budget", String(cfg.reasoningBudget)] : []),
  ];
}

const bunSpawn: EngineSpawn = (argv) =>
  Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
const unrefTimer: Timer = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
};
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function readJson<T>(path: string, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export class AiEngine {
  private proc: EngineProcess | null = null;
  private starting: Promise<void> | null = null;
  private status: Pick<AiState, "state" | "detail"> = { state: "off", detail: null };
  private inFlight = 0;
  private cancelIdle: (() => void) | null = null;
  private gameMode: boolean;
  private readonly paths: ReturnType<typeof aiPaths>;
  private readonly fetch: Fetch;

  constructor(
    private readonly cfg: EngineConfig,
    private readonly deps: EngineDeps,
  ) {
    this.paths = aiPaths(deps.dataDir);
    this.gameMode = readJson(this.paths.mode, ModeFile)?.gameMode ?? false;
    this.fetch = deps.fetch ?? ((url, init) => fetch(url, init));
  }

  state(): AiState {
    return {
      ...this.status,
      gameMode: this.gameMode,
      inFlight: this.inFlight,
      idleMinutes: this.cfg.idleMinutes,
    };
  }

  // Starts the engine unless it runs; concurrent callers share one start.
  async ensure(): Promise<void> {
    if (this.gameMode)
      throw new AiError(
        "ai_game_mode",
        "El modo juego está activo en el PC: la IA local no arranca hasta que lo quites.",
      );
    if (this.proc && this.status.state === "ready") return;
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  // One request to the engine, path and query included (`/v1/messages?beta=true`). The engine
  // counts as busy until the answer's body ends or the caller leaves.
  async forward(path: string, init: RequestInit): Promise<Response> {
    await this.ensure();
    this.inFlight++;
    this.cancelIdle?.();
    this.cancelIdle = null;
    let open = true;
    const finish = () => {
      if (!open) return;
      open = false;
      this.inFlight--;
      this.armIdle();
    };
    let res: Response;
    try {
      res = await this.fetch(`http://127.0.0.1:${this.cfg.port}${path}`, init);
    } catch (err) {
      finish();
      throw new AiError("ai_unavailable", `el motor no responde: ${errorMessage(err)}`);
    }
    const headers = new Headers();
    res.headers.forEach((value, name) => {
      if (!DROP.has(name)) headers.set(name, value);
    });
    if (!res.body) {
      finish();
      return new Response(null, { status: res.status, headers });
    }
    const reader = res.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(ctl) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            finish();
            ctl.close();
          } else ctl.enqueue(chunk.value);
        } catch (err) {
          finish();
          ctl.error(err);
        }
      },
      cancel(reason) {
        finish();
        return reader.cancel(reason);
      },
    });
    return new Response(body, { status: res.status, headers });
  }

  stop(why = "stopped"): void {
    this.cancelIdle?.();
    this.cancelIdle = null;
    const proc = this.proc;
    this.proc = null;
    this.status = { state: "off", detail: null };
    if (!proc) return;
    rmSync(this.paths.pid, { force: true });
    proc.kill();
    log("ai").info(`engine ${proc.pid} ${why}`);
  }

  setGameMode(on: boolean): void {
    this.gameMode = on;
    writeFileSync(this.paths.mode, JSON.stringify({ gameMode: on }));
    if (on) this.stop("stopped for game mode");
  }

  // Ends an engine a previous server of ours left running (a crash, or a restart on Windows,
  // where the parent's end does not end its children), so it does not hold the GPU unseen.
  async reapLeftover(): Promise<void> {
    const file = readJson(this.paths.pid, PidFile);
    if (!file || file.pid === this.proc?.pid) return;
    const alive = this.deps.alive ?? isAlive;
    if (alive(file.pid)) {
      const cmd = (await (this.deps.commandLine ?? commandLine)(file.pid)).toLowerCase();
      const bin = this.cfg.bin.replaceAll("\\", "/").split("/").pop()?.toLowerCase() ?? "";
      if (cmd.includes(bin) && cmd.includes(`--port ${this.cfg.port}`)) {
        (this.deps.killTree ?? killTree)(file.pid);
        for (let i = 0; i < 20 && alive(file.pid); i++) await this.sleep(POLL_MS);
        log("ai").info(`ended leftover engine ${file.pid}`);
      }
    }
    rmSync(this.paths.pid, { force: true });
  }

  private sleep(ms: number): Promise<void> {
    return (this.deps.sleep ?? Bun.sleep)(ms);
  }

  private async healthy(): Promise<boolean> {
    try {
      const res = await this.fetch(`http://127.0.0.1:${this.cfg.port}/health`, {
        signal: AbortSignal.timeout(HEALTH_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async start(): Promise<void> {
    this.status = { state: "starting", detail: null };
    try {
      await this.reapLeftover();
      if (await this.healthy())
        throw new AiError(
          "ai_unavailable",
          `el puerto ${this.cfg.port} ya responde y no es un motor arrancado por Agentic OS`,
        );
      const proc = (this.deps.spawn ?? bunSpawn)(engineArgv(this.cfg));
      this.proc = proc;
      writeFileSync(this.paths.pid, JSON.stringify({ pid: proc.pid }));
      log("ai").info(`engine ${proc.pid} starting`);
      void this.keepLog(proc.stderr);
      void proc.exited.then((code) => {
        if (this.proc !== proc) return;
        this.proc = null;
        this.cancelIdle?.();
        this.cancelIdle = null;
        rmSync(this.paths.pid, { force: true });
        this.status = { state: "failed", detail: `el motor terminó con código ${code}` };
        log("ai").error(`engine ${proc.pid} exited ${code}`);
      });
      const now = this.deps.now ?? Date.now;
      const deadline = now() + (this.deps.startMs ?? START_MS);
      while (!(await this.healthy())) {
        if (this.proc !== proc)
          throw new AiError("ai_unavailable", this.status.detail ?? "el motor se paró al arrancar");
        if (now() > deadline) {
          this.stop("did not become healthy");
          throw new AiError("ai_unavailable", "el motor no ha arrancado a tiempo");
        }
        await this.sleep(POLL_MS);
      }
      if (this.proc !== proc)
        throw new AiError("ai_unavailable", "el motor se paró mientras arrancaba");
      this.status = { state: "ready", detail: null };
      log("ai").info(`engine ${proc.pid} ready`);
      this.armIdle();
    } catch (err) {
      const error = err instanceof AiError ? err : new AiError("ai_unavailable", errorMessage(err));
      if (this.status.state === "starting")
        this.status = { state: "failed", detail: error.message };
      throw error;
    }
  }

  private armIdle(): void {
    if (this.inFlight > 0 || !this.proc) return;
    this.cancelIdle?.();
    this.cancelIdle = (this.deps.timer ?? unrefTimer)(() => {
      this.cancelIdle = null;
      if (this.inFlight === 0) this.stop(`stopped after ${this.cfg.idleMinutes} idle minutes`);
    }, this.cfg.idleMinutes * 60_000);
  }

  // The engine's own lines (load, slots, timings; no prompts) go to ai-engine.log, which the
  // system logs show.
  private async keepLog(stderr: ReadableStream<Uint8Array>): Promise<void> {
    try {
      for await (const chunk of stderr) appendFileSync(this.paths.log, chunk);
    } catch (err) {
      log("ai").warn(`engine log stopped: ${errorMessage(err)}`);
    }
  }
}
