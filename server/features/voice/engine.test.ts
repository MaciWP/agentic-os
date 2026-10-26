import { describe, expect, test } from "bun:test";
import type { Timer } from "../system/keep-awake.ts";
import { VoiceEngine, VoiceError, type WorkerProcess } from "./engine.ts";

const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const tick = () => new Promise((r) => setTimeout(r, 0));

// A worker the test speaks for: what the engine wrote to it, and what it prints back.
function fakeWorker() {
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let exit!: (code: number) => void;
  let stderr = "";
  const sent: { id: number; pcm: string }[] = [];
  const state = { killed: false, ended: false };
  const proc: WorkerProcess = {
    stdin: {
      write: (chunk: string) => sent.push(JSON.parse(chunk)),
      flush: () => {},
      end: () => {
        state.ended = true;
      },
    },
    stdout: new ReadableStream({
      start(c) {
        out = c;
      },
    }),
    stderr: new ReadableStream({
      async pull(c) {
        await exited;
        if (stderr) c.enqueue(new TextEncoder().encode(stderr));
        c.close();
      },
    }),
    exited: new Promise<number>(() => {}),
    kill: () => {
      state.killed = true;
      finish(143);
    },
  };
  const exited = new Promise<number>((r) => {
    exit = r;
  });
  proc.exited = exited;
  let done = false;
  const finish = (code: number, err = "") => {
    if (done) return;
    done = true;
    stderr = err;
    out.close();
    exit(code);
  };
  return {
    proc,
    sent,
    state,
    say: (o: unknown) => out.enqueue(new TextEncoder().encode(line(o))),
    finish,
  };
}

function setup() {
  const workers: ReturnType<typeof fakeWorker>[] = [];
  const argvs: string[][] = [];
  const timers: { fn: () => void; ms: number; on: boolean }[] = [];
  const timer: Timer = (fn, ms) => {
    const t = { fn, ms, on: true };
    timers.push(t);
    return () => {
      t.on = false;
    };
  };
  const fire = (ms: number) => {
    for (const t of timers.filter((t) => t.on && t.ms === ms)) {
      t.on = false;
      t.fn();
    }
  };
  const engine = new VoiceEngine("/models/parakeet", {
    idleMs: 600_000,
    timeoutMs: 60_000,
    timer,
    spawn: (argv) => {
      argvs.push(argv);
      const w = fakeWorker();
      workers.push(w);
      return w.proc;
    },
  });
  return { engine, workers, argvs, fire };
}

describe("voice engine", () => {
  test("nothing runs until the first dictation; the model is loaded once", async () => {
    const { engine, workers, argvs } = setup();
    expect(engine.state()).toEqual({ state: "off", detail: null });
    expect(workers).toHaveLength(0);

    const first = engine.transcribe("AAAA");
    await tick();
    expect(argvs[0]?.slice(1)).toEqual([
      expect.stringMatching(/worker\.ts$/),
      "/models/parakeet",
      "{}",
    ]);
    expect(engine.state().state).toBe("loading");
    // The request waits for the model.
    expect(workers[0]?.sent).toEqual([]);
    workers[0]?.say({ ready: true });
    await tick();
    expect(engine.state().state).toBe("ready");
    expect(workers[0]?.sent).toEqual([{ id: 1, pcm: "AAAA" }]);
    workers[0]?.say({ id: 1, text: "hola", ms: 120 });
    expect(await first).toEqual({ text: "hola", ms: 120 });

    const second = engine.transcribe("BBBB");
    await tick();
    workers[0]?.say({ id: 2, text: "adiós", ms: 90 });
    expect(await second).toEqual({ text: "adiós", ms: 90 });
    expect(workers).toHaveLength(1);
  });

  test("one dictation at a time: the next is sent once the one before is answered", async () => {
    const { engine, workers } = setup();
    const a = engine.transcribe("AAAA");
    const b = engine.transcribe("BBBB");
    await tick();
    workers[0]?.say({ ready: true });
    await tick();
    expect(workers[0]?.sent.map((s) => s.pcm)).toEqual(["AAAA"]);
    workers[0]?.say({ id: 1, text: "uno", ms: 1 });
    await a;
    await tick();
    expect(workers[0]?.sent.map((s) => s.pcm)).toEqual(["AAAA", "BBBB"]);
    workers[0]?.say({ id: 2, text: "dos", ms: 1 });
    expect((await b).text).toBe("dos");
  });

  test("warm loads the model ahead; idle minutes end it, and the next dictation starts again", async () => {
    const { engine, workers, fire } = setup();
    engine.warm();
    expect(workers).toHaveLength(1);
    workers[0]?.say({ ready: true });
    await tick();
    expect(engine.state().state).toBe("ready");

    fire(600_000);
    expect(workers[0]?.state).toEqual({ killed: true, ended: true });
    expect(engine.state()).toEqual({ state: "off", detail: null });
    await tick();

    const next = engine.transcribe("AAAA");
    await tick();
    expect(workers).toHaveLength(2);
    workers[1]?.say({ ready: true });
    await tick();
    workers[1]?.say({ id: 1, text: "otra vez", ms: 1 });
    expect((await next).text).toBe("otra vez");
  });

  test("a worker that dies says why, and the next dictation tries a new one", async () => {
    const { engine, workers } = setup();
    const lost = engine.transcribe("AAAA");
    await tick();
    workers[0]?.finish(1, "Error: cannot open encoder.int8.onnx\n");
    const err = await lost.catch((e) => e);
    expect(err).toBeInstanceOf(VoiceError);
    expect(err.message).toBe("the voice worker ended (1): Error: cannot open encoder.int8.onnx");
    expect(engine.state().state).toBe("failed");

    const again = engine.transcribe("AAAA");
    await tick();
    expect(workers).toHaveLength(2);
    workers[1]?.say({ ready: true });
    await tick();
    workers[1]?.say({ id: 1, text: "ya", ms: 1 });
    expect((await again).text).toBe("ya");
  });

  test("a decode error fails that dictation only; junk lines are skipped", async () => {
    const { engine, workers } = setup();
    const errors: string[] = [];
    const original = console.error;
    console.error = (msg: string) => errors.push(msg.replace(/^\S+ (INFO|WARN|ERROR) /, ""));
    try {
      const bad = engine.transcribe("AAAA");
      await tick();
      workers[0]?.say({ ready: true });
      await tick();
      workers[0]?.say("not a line");
      workers[0]?.say({ id: 1, error: "bad request" });
      const err = await bad.catch((e) => e);
      expect(err).toBeInstanceOf(VoiceError);
      expect(err.message).toBe("bad request");
      expect(engine.state().state).toBe("ready");
      // The line's content is never logged: it could be what was said.
      expect(errors).toEqual(["voice: unreadable worker line (12 chars)"]);
    } finally {
      console.error = original;
    }
  });

  test("a worker silent past the timeout is ended, and the dictation fails", async () => {
    const { engine, workers, fire } = setup();
    const stuck = engine.transcribe("AAAA");
    await tick();
    workers[0]?.say({ ready: true });
    await tick();
    fire(60_000);
    const err = await stuck.catch((e) => e);
    expect(err.message).toBe("the voice worker stopped answering");
    expect(workers[0]?.state.killed).toBe(true);
    expect(engine.state()).toEqual({
      state: "failed",
      detail: "the voice worker stopped answering",
    });
  });

  test("stop ends the worker and fails what was waiting", async () => {
    const { engine, workers } = setup();
    const waiting = engine.transcribe("AAAA");
    await tick();
    engine.stop();
    expect((await waiting.catch((e) => e)).message).toBe("the voice worker was stopped");
    expect(workers[0]?.state.killed).toBe(true);
    expect(engine.state()).toEqual({ state: "off", detail: null });
  });
});
