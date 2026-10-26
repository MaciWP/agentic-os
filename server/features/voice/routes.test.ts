import { describe, expect, test } from "bun:test";
import { MAX_DICTATION_BYTES } from "../../../shared/voice.ts";
import { SERVER_ERRORS } from "../../app-errors.ts";
import { errorHandler } from "../../errors.ts";
import { VoiceEngine, VoiceError } from "./engine.ts";
import { voiceRoutes } from "./routes.ts";

const post = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const pcm = (bytes: number) => Buffer.alloc(bytes).toString("base64");

// An engine that answers from the test, with no worker behind it.
function engineSaying(answer: () => Promise<{ text: string; ms: number }>) {
  const engine = new VoiceEngine("/models/parakeet", { idleMs: 1 });
  const calls: string[] = [];
  let warmed = 0;
  engine.transcribe = (audio) => {
    calls.push(audio);
    return answer();
  };
  engine.warm = () => {
    warmed++;
  };
  return { engine, calls, warmed: () => warmed };
}

function logged<T>(run: () => Promise<T>) {
  const lines: string[] = [];
  const original = { log: console.log, error: console.error };
  console.log = console.error = (msg: string) =>
    lines.push(msg.replace(/^\S+ (INFO|WARN|ERROR) /, ""));
  return run()
    .then((result) => ({ result, lines }))
    .finally(() => {
      console.log = original.log;
      console.error = original.error;
    });
}

describe("voice routes", () => {
  test("without a model the feature says it is off and how to turn it on", async () => {
    const app = voiceRoutes(null, (t) => t);
    expect(await (await app.request("/")).json()).toEqual({
      configured: false,
      state: "off",
      detail: null,
      browserProcessing: true,
      warmSeconds: 0,
    });
    for (const path of ["/warm", "/transcribe"]) {
      const res = await app.request(path, post({ audio: pcm(4) }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "voice_not_configured",
        detail: "add voice.model to config.json",
      });
    }
  });

  test("a dictation comes back normalized; only its length and timing are logged", async () => {
    const { engine, calls } = engineSaying(async () => ({ text: "revisa  ABC 1077", ms: 210 }));
    const app = voiceRoutes(engine, (t) => t.replace("ABC 1077", "ABC-1077"));
    const audio = pcm(32_000 * 3);
    const { result: res, lines } = await logged(async () =>
      app.request("/transcribe", post({ audio })),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "revisa  ABC-1077" });
    expect(calls).toEqual([audio]);
    expect(lines).toEqual(["voice: 3.0 s audio, 210 ms"]);
  });

  test("warm starts the model and reports the engine's state", async () => {
    const { engine, warmed } = engineSaying(async () => ({ text: "", ms: 0 }));
    const app = voiceRoutes(engine, (t) => t);
    expect((await app.request("/warm", post({}))).status).toBe(200);
    expect(warmed()).toBe(1);
    expect(await (await app.request("/")).json()).toEqual({
      configured: true,
      state: "off",
      detail: null,
      browserProcessing: true,
      warmSeconds: 0,
    });
  });

  test("anything but 16-bit PCM in base64 is refused before the model sees it", async () => {
    const { engine, calls } = engineSaying(async () => ({ text: "", ms: 0 }));
    const app = voiceRoutes(engine, (t) => t);
    const bodies = [
      {},
      { audio: "not base64!" },
      { audio: pcm(3) },
      "nope",
      { audio: "" },
      { audio: pcm(MAX_DICTATION_BYTES + 2) },
    ];
    for (const body of bodies) {
      const res = await app.request("/transcribe", post(body));
      expect(res.status).toBe(400);
    }
    const huge = await app.request("/transcribe", post({ audio: pcm(MAX_DICTATION_BYTES * 2) }));
    expect(huge.status).toBe(413);
    expect(calls).toEqual([]);
  });

  test("with the test set on, each dictation is kept with what was heard; a failure to keep it costs nothing", async () => {
    const { engine } = engineSaying(async () => ({ text: "abc 12", ms: 5 }));
    const kept: { bytes: number; raw: string; text: string }[] = [];
    const app = voiceRoutes(engine, (t) => t.toUpperCase(), {
      keep: async (audio, heard) => {
        kept.push({ bytes: audio.length, ...heard });
      },
    });
    const res = await app.request("/transcribe", post({ audio: pcm(64) }));
    expect(await res.json()).toEqual({ text: "ABC 12" });
    expect(kept).toEqual([{ bytes: 64, raw: "abc 12", text: "ABC 12" }]);

    const broken = voiceRoutes(engine, (t) => t, {
      keep: async () => {
        throw new Error("disk full");
      },
    });
    const { result, lines } = await logged(async () =>
      broken.request("/transcribe", post({ audio: pcm(64) })),
    );
    expect(await result.json()).toEqual({ text: "abc 12" });
    expect(lines).toContain("voice: could not keep the dictation: disk full");
  });

  test("the page learns how to open the microphone", async () => {
    const { engine } = engineSaying(async () => ({ text: "", ms: 0 }));
    const app = voiceRoutes(engine, (t) => t, {
      capture: { browserProcessing: false, warmSeconds: 30 },
    });
    expect(await (await app.request("/")).json()).toMatchObject({
      configured: true,
      browserProcessing: false,
      warmSeconds: 30,
    });
  });

  test("a failed model says why", async () => {
    const { engine } = engineSaying(async () => {
      throw new VoiceError("the voice worker ended (1): no model");
    });
    // A VoiceError is answered by the app's error registry, as in the server.
    const app = voiceRoutes(engine, (t) => t).onError(errorHandler(SERVER_ERRORS));
    const { result: res, lines } = await logged(async () =>
      app.request("/transcribe", post({ audio: pcm(32_000) })),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "voice_failed",
      detail: "the voice worker ended (1): no model",
    });
    expect(lines).toEqual(["voice: failed on 1.0 s audio: the voice worker ended (1): no model"]);
  });

  test("how a dictation ended reaches the log, on one line", async () => {
    const app = voiceRoutes(null, (t) => t);
    const { lines } = await logged(async () => {
      for (const body of [
        { outcome: "done", seconds: 34.2, openMs: 140, waitMs: 380 },
        {
          outcome: "done",
          seconds: 2,
          openMs: 280,
          deviceMs: 250,
          audioMs: 20,
          mic: "Chat-Audeze  Maxwell",
          rate: 48000,
        },
        { outcome: "done", seconds: 1, openMs: 4, warm: true },
        { outcome: "too_short", seconds: 0.1 },
        { outcome: "failed", seconds: 8, detail: "the voice\nworker stopped" },
      ])
        expect((await app.request("/report", post(body))).status).toBe(200);
    });
    expect(lines).toEqual([
      "voice: done 34.2 s, mic 140 ms, 380 ms after release",
      "voice: done 2.0 s, mic 280 ms (device 250, audio 20), on Chat-Audeze Maxwell 48000 Hz",
      "voice: done 1.0 s, mic 4 ms (warm)",
      "voice: too_short 0.1 s",
      "voice: failed 8.0 s: the voice worker stopped",
    ]);
  });

  test("a report carries only known outcomes and bounded numbers, never text", async () => {
    const app = voiceRoutes(null, (t) => t);
    for (const body of [
      { outcome: "said", seconds: 1 },
      { outcome: "done", seconds: -1 },
      { outcome: "done", seconds: 1, text: "hola" },
      { outcome: "done", seconds: 1, parts: 2 },
      { outcome: "done", seconds: 1, detail: "x".repeat(301) },
    ])
      expect((await app.request("/report", post(body))).status).toBe(400);
  });
});
