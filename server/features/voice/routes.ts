import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  MAX_DICTATION_BYTES,
  MAX_DICTATION_SECONDS,
  VOICE_SAMPLE_RATE,
} from "../../../shared/voice.ts";
import { errorMessage } from "../../error-message.ts";
import { log } from "../../log.ts";
import { type VoiceEngine, VoiceError } from "./engine.ts";
import type { KeepDictation } from "./eval-capture.ts";

// The longest dictation in base64 is this route's largest body.
const voiceBodyLimit = bodyLimit({
  maxSize: Math.ceil(MAX_DICTATION_BYTES / 3) * 4 + 1024,
  onError: (c) => c.json({ error: "too_large", detail: "dictation too long" }, 413),
});

const TranscribeBody = z.strictObject({ audio: z.base64().min(4) });

// How a dictation ended, from the browser: discards and failures that never reach the model,
// how long the microphone took to give its first sound, and the wait after the keys are
// released. `detail` is the app's own error text.
const ReportBody = z.strictObject({
  outcome: z.enum(["done", "too_short", "silent", "mic_error", "failed", "cancelled"]),
  seconds: z
    .number()
    .min(0)
    .max(MAX_DICTATION_SECONDS + 10),
  openMs: z.number().int().min(0).max(60_000).optional(),
  waitMs: z.number().int().min(0).max(600_000).optional(),
  detail: z.string().max(300).optional(),
  // The input device's name and rate: a slow-to-open headset and the built-in mic differ.
  mic: z.string().max(120).optional(),
  rate: z.number().int().min(0).max(384_000).optional(),
  // Split of `openMs` when the microphone was opened for this dictation: the device itself, and
  // the browser's audio after it. `warm`: it was already open.
  deviceMs: z.number().int().min(0).max(60_000).optional(),
  audioMs: z.number().int().min(0).max(60_000).optional(),
  warm: z.literal(true).optional(),
});

const NOT_CONFIGURED = {
  error: "voice_not_configured",
  detail: "add voice.model to config.json",
} as const;

// Speech to text, and nothing else: whoever asked puts the text where it belongs. Neither the
// audio nor the text is kept or logged; lengths, timings and errors are.
// `capture`: how the browser opens the microphone. `keep`: the opt-in real-voice test set.
export function voiceRoutes(
  engine: VoiceEngine | null,
  normalize: (text: string) => string,
  {
    keep,
    capture = { browserProcessing: true, warmSeconds: 0 },
  }: { keep?: KeepDictation; capture?: { browserProcessing: boolean; warmSeconds: number } } = {},
) {
  const browser = {
    browserProcessing: capture.browserProcessing,
    warmSeconds: capture.warmSeconds,
  };
  return new Hono()
    .get("/", (c) =>
      c.json(
        engine
          ? { configured: true, ...engine.state(), ...browser }
          : { configured: false, state: "off" as const, detail: null, ...browser },
      ),
    )
    .post("/warm", (c) => {
      if (!engine) return c.json(NOT_CONFIGURED, 400);
      engine.warm();
      return c.json({ ok: true });
    })
    .post("/transcribe", voiceBodyLimit, async (c) => {
      const body = TranscribeBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
      if (!engine) return c.json(NOT_CONFIGURED, 400);
      const { audio } = body.data;
      const bytes = Buffer.byteLength(audio, "base64");
      if (bytes % 2 !== 0 || bytes > MAX_DICTATION_BYTES)
        return c.json({ error: "bad_request", detail: "audio is not 16-bit PCM" }, 400);
      try {
        const { text, ms } = await engine.transcribe(audio);
        log("voice").info(`${seconds(bytes)} s audio, ${ms} ms`);
        const out = normalize(text);
        // Keeping it must never cost the dictation.
        await keep?.(Buffer.from(audio, "base64"), { raw: text, text: out }).catch((err) =>
          log("voice").error(`could not keep the dictation: ${errorMessage(err)}`),
        );
        return c.json({ text: out });
      } catch (err) {
        // The app's error registry answers it; only the audio length is said here.
        if (err instanceof VoiceError)
          log("voice").info(`failed on ${seconds(bytes)} s audio: ${err.message}`);
        throw err;
      }
    })
    .post("/report", async (c) => {
      const body = ReportBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "bad_request", detail: body.error.issues }, 400);
      const { outcome, seconds: s, openMs, waitMs, detail, mic, rate } = body.data;
      const { deviceMs, audioMs, warm } = body.data;
      const split =
        deviceMs !== undefined && audioMs !== undefined
          ? ` (device ${deviceMs}, audio ${audioMs})`
          : warm
            ? " (warm)"
            : "";
      const facts = [
        `${s.toFixed(1)} s`,
        openMs === undefined ? null : `mic ${openMs} ms${split}`,
        mic === undefined ? null : `on ${mic.replace(/\s+/g, " ")}${rate ? ` ${rate} Hz` : ""}`,
        waitMs === undefined ? null : `${waitMs} ms after release`,
      ].filter(Boolean);
      const why = detail ? `: ${detail.replace(/\s+/g, " ")}` : "";
      log("voice").info(`${outcome} ${facts.join(", ")}${why}`);
      return c.json({ ok: true });
    });
}

const seconds = (bytes: number) => (bytes / 2 / VOICE_SAMPLE_RATE).toFixed(1);
