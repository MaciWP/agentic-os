// Dictation in, text out. The model (Parakeet V3 int8: ~640 MB on disk, ~1.2 GB loaded) lives
// in a child process: the first dictation starts it, a few idle minutes end it, so nothing is
// held while nobody dictates. A native crash ends the child, never the server. No port is
// opened: requests go through the child's stdin and stdout.
import { join } from "node:path";
import { z } from "zod";
import { log } from "../../log.ts";
import type { Timer } from "../system/keep-awake.ts";

export type VoiceState = {
  state: "off" | "loading" | "ready" | "failed";
  detail: string | null;
};

export class VoiceError extends Error {}

export type WorkerProcess = {
  stdin: { write(chunk: string): unknown; flush(): unknown; end(): unknown };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
};
export type WorkerSpawn = (argv: string[]) => WorkerProcess;

// The longest dictation decodes in a few seconds; a worker silent for this long is stuck.
export const REQUEST_TIMEOUT_MS = 60_000;
const WORKER = join(import.meta.dir, "worker.ts");

// The user's own words, which the model is told to expect (`voice.terms`, the targets of
// `voice.replace`, the Jira key), and how hard Parakeet leans towards them.
export const WorkerOptions = z.strictObject({
  terms: z.array(z.string().min(1)).default([]),
  boost: z.number().positive().default(5),
});
export type WorkerOptions = z.input<typeof WorkerOptions>;

const Line = z.union([
  z.strictObject({ ready: z.literal(true) }),
  z.strictObject({ id: z.number().int(), text: z.string(), ms: z.number() }),
  z.strictObject({ id: z.number().int(), error: z.string() }),
]);

const bunSpawn: WorkerSpawn = (argv) =>
  Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
const unrefTimer: Timer = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
};

type Pending = { resolve: (r: { text: string; ms: number }) => void; reject: (e: Error) => void };
type Worker = { proc: WorkerProcess; ready: Promise<void>; fail: (e: Error) => void };

export class VoiceEngine {
  private worker: Worker | null = null;
  private status: VoiceState = { state: "off", detail: null };
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  // One dictation at a time: the next waits for the one before.
  private queue: Promise<unknown> = Promise.resolve();
  private cancelIdle: (() => void) | null = null;

  constructor(
    private readonly modelDir: string,
    private readonly opts: {
      idleMs: number;
      words?: WorkerOptions;
      spawn?: WorkerSpawn;
      timer?: Timer;
      timeoutMs?: number;
    },
  ) {}

  state(): VoiceState {
    return this.status;
  }

  // Loads the model while the user is still speaking, so the first dictation after an idle
  // spell does not wait for it.
  warm(): void {
    this.start().ready.catch(() => {});
    this.armIdle();
  }

  // `pcm`: base64 PCM16 mono at VOICE_SAMPLE_RATE.
  transcribe(pcm: string): Promise<{ text: string; ms: number }> {
    const run = this.queue.then(() => this.run(pcm));
    this.queue = run.catch(() => {});
    return run;
  }

  stop(): void {
    this.cancelIdle?.();
    this.cancelIdle = null;
    this.end(null);
  }

  private async run(pcm: string): Promise<{ text: string; ms: number }> {
    this.cancelIdle?.();
    this.cancelIdle = null;
    try {
      const worker = this.start();
      await worker.ready;
      return await this.request(worker, pcm);
    } finally {
      this.armIdle();
    }
  }

  private request(worker: Worker, pcm: string): Promise<{ text: string; ms: number }> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const cancel = (this.opts.timer ?? unrefTimer)(() => {
        // Stuck: the next dictation starts a fresh worker.
        if (this.pending.has(id)) this.end("the voice worker stopped answering");
      }, this.opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (r) => {
          cancel();
          resolve(r);
        },
        reject: (e) => {
          cancel();
          reject(e);
        },
      });
      worker.proc.stdin.write(`${JSON.stringify({ id, pcm })}\n`);
      worker.proc.stdin.flush();
    });
  }

  private armIdle(): void {
    this.cancelIdle?.();
    this.cancelIdle = (this.opts.timer ?? unrefTimer)(() => {
      this.cancelIdle = null;
      if (this.pending.size === 0) this.end(null);
    }, this.opts.idleMs);
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const proc = (this.opts.spawn ?? bunSpawn)([
      process.execPath,
      WORKER,
      this.modelDir,
      JSON.stringify(this.opts.words ?? {}),
    ]);
    this.status = { state: "loading", detail: null };
    let loaded: () => void = () => {};
    let failed: (e: Error) => void = () => {};
    const ready = new Promise<void>((resolve, reject) => {
      loaded = resolve;
      failed = reject;
    });
    const worker: Worker = { proc, ready, fail: (e) => failed(e) };
    this.worker = worker;
    const stderr = new Response(proc.stderr).text();
    void Promise.all([this.read(proc, loaded), stderr, proc.exited]).then(([, err, code]) => {
      const detail = `the voice worker ended (${code}): ${err.trim().slice(-300) || "no message"}`;
      failed(new VoiceError(detail));
      if (this.worker === worker) this.end(detail);
    });
    return worker;
  }

  private async read(proc: WorkerProcess, loaded: () => void): Promise<void> {
    const decoder = new TextDecoder();
    let rest = "";
    for await (const chunk of proc.stdout) {
      rest += decoder.decode(chunk, { stream: true });
      let newline = rest.indexOf("\n");
      while (newline !== -1) {
        this.handle(rest.slice(0, newline), loaded);
        rest = rest.slice(newline + 1);
        newline = rest.indexOf("\n");
      }
    }
  }

  private handle(text: string, loaded: () => void): void {
    if (!text.trim()) return;
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {}
    const line = Line.safeParse(json);
    if (!line.success) {
      log("voice").error(`unreadable worker line (${text.length} chars)`);
      return;
    }
    const data = line.data;
    if ("ready" in data) {
      this.status = { state: "ready", detail: null };
      loaded();
      return;
    }
    const waiting = this.pending.get(data.id);
    if (!waiting) return;
    this.pending.delete(data.id);
    if ("error" in data) waiting.reject(new VoiceError(data.error));
    else waiting.resolve({ text: data.text, ms: data.ms });
  }

  // `detail` null: ended on purpose (idle, stop); otherwise it failed, and says why.
  private end(detail: string | null): void {
    const worker = this.worker;
    this.worker = null;
    this.status = detail ? { state: "failed", detail } : { state: "off", detail: null };
    const error = new VoiceError(detail ?? "the voice worker was stopped");
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    if (!worker) return;
    // A dictation still waiting for the model hears this, not the kill's exit code.
    worker.fail(error);
    worker.proc.stdin.end();
    worker.proc.kill();
  }
}
