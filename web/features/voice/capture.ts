import { MAX_DICTATION_SECONDS, VOICE_SAMPLE_RATE } from "../../../shared/voice.ts";
import { createStore } from "../../store.ts";

// The microphone, held while recording and `warmSeconds` after: macOS shows its dot as long.
// The browser resamples to the model's rate, so the server gets PCM it can decode as is.

export class CaptureError extends Error {}

export type Recording = {
  // Releases the microphone and returns all that was heard; `pcm` is null when it held no voice.
  // `openMs` is how long the microphone took to give its first sound.
  // `mic` and `rate` name the input device, for the log.
  stop(): {
    pcm: Int16Array | null;
    seconds: number;
    openMs: number | null;
    mic: string | null;
    rate: number | null;
    // Null when a warm microphone was reused.
    opening: { deviceMs: number; audioMs: number } | null;
  };
  cancel(): void;
};

// Copies each 128-sample frame out of the audio thread. Loaded from a Blob, so it needs no
// build step of its own.
const WORKLET = `registerProcessor("aos-capture", class extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
});`;

// One dictation at a time across every terminal.
const active = createStore(false);

export function toPcm16(chunks: Float32Array[]): Int16Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Int16Array(total);
  let i = 0;
  for (const chunk of chunks)
    for (const s of chunk) out[i++] = Math.max(-1, Math.min(1, s)) * (s < 0 ? 0x8000 : 0x7fff);
  return out;
}

export const rms = (chunk: Float32Array) =>
  Math.sqrt(chunk.reduce((sum, s) => sum + s * s, 0) / (chunk.length || 1));

// Exact zeros: the device is not delivering sound yet, as opposed to a quiet room.
export const silentFrame = (frame: Float32Array) => frame.every((s) => s === 0);

// A recording with no frame louder than this is silence.
export const QUIET = 0.01;

// The audio graph outlives a dictation: building it again each time delayed the first sound,
// and a quick "sí, hazlo" lost its "sí". Suspended between dictations, it uses nothing.
const graph = createStore<Promise<AudioContext> | null>(null);
// Also called ahead, when a terminal opens: a context made without a key press only starts
// suspended, which is how it waits anyway.
export function audioGraph(): Promise<AudioContext> {
  const current = graph.get();
  if (current) return current;
  const next = (async () => {
    // Nothing is ever played: without an output device, resuming the context does not wake the
    // speakers or headset first (Chromium; other browsers ignore the option).
    const ctx = new AudioContext({
      sampleRate: VOICE_SAMPLE_RATE,
      sinkId: { type: "none" },
    } as AudioContextOptions);
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    return ctx;
  })();
  graph.set(next);
  next.catch(() => graph.set(null));
  return next;
}

// How the page opens the microphone (`voice` in config.json).
export type CaptureSettings = { browserProcessing: boolean; warmSeconds: number };

// An open microphone feeding the audio graph. Kept open `warmSeconds` after a dictation, so the
// next one hears from the first moment: a USB headset took about 280 ms to give its first sound,
// and a word said in that time was lost. Nothing is recorded while it waits.
type Mic = {
  stream: MediaStream;
  ctx: AudioContext;
  source: MediaStreamAudioSourceNode;
  node: AudioWorkletNode;
  processing: boolean;
  closeLater: ReturnType<typeof setTimeout> | null;
  // How long the device and the browser's audio took to start, when this dictation opened it.
  opening: { deviceMs: number; audioMs: number } | null;
};
const warm = createStore<Mic | null>(null);

function close(mic: Mic) {
  if (mic.closeLater) clearTimeout(mic.closeLater);
  mic.node.port.onmessage = null;
  for (const track of mic.stream.getTracks()) track.stop();
  mic.source.disconnect();
  mic.node.disconnect();
  void mic.ctx.suspend();
  if (warm.get() === mic) warm.set(null);
}

// A warm microphone, if it is still live and opened the same way.
function takeWarm(processing: boolean): Mic | null {
  const mic = warm.get();
  warm.set(null);
  if (!mic) return null;
  if (mic.closeLater) clearTimeout(mic.closeLater);
  mic.closeLater = null;
  const live = mic.stream.getAudioTracks().some((t) => t.readyState === "live");
  if (live && mic.processing === processing && mic.ctx.state === "running") return mic;
  close(mic);
  return null;
}

async function openMic(processing: boolean): Promise<Mic> {
  const asked = performance.now();
  let deviceAt = asked;
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  try {
    // The microphone and the audio graph start together; neither waits for the other.
    // Both settle before going on, so a failure of one never leaves the other's microphone on.
    const [mic, built] = await Promise.allSettled([
      navigator.mediaDevices
        .getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: processing,
            noiseSuppression: processing,
            autoGainControl: processing,
          },
        })
        .then((s) => {
          deviceAt = performance.now();
          return s;
        }),
      audioGraph(),
    ]);
    if (mic.status === "fulfilled") stream = mic.value;
    if (built.status === "fulfilled") ctx = built.value;
    if (mic.status === "rejected") throw mic.reason;
    if (built.status === "rejected") throw built.reason;
    if (!stream || !ctx) throw new CaptureError("no se ha podido abrir el micrófono");
    const graphAt = Math.max(deviceAt, performance.now());
    await ctx.resume();
    // A context the page may not start yet records nothing: say so instead of an empty take.
    if (ctx.state !== "running")
      throw new CaptureError("el audio del navegador no ha arrancado; haz clic en la terminal");
    const node = new AudioWorkletNode(ctx, "aos-capture");
    const source = ctx.createMediaStreamSource(stream);
    source.connect(node);
    const opening = {
      deviceMs: Math.round(deviceAt - asked),
      audioMs: Math.round(performance.now() - graphAt),
    };
    return { stream, ctx, source, node, processing, closeLater: null, opening };
  } catch (err) {
    for (const track of stream?.getTracks() ?? []) track.stop();
    void ctx?.suspend();
    throw err;
  }
}

// `onLive` fires once, with the first sound: the moment speaking is safe.
export async function startRecording(
  onLevel: (level: number) => void,
  settings: CaptureSettings,
  onLive: () => void = () => {},
): Promise<Recording> {
  if (active.get()) throw new CaptureError("ya hay un dictado en marcha");
  // Browsers give the microphone only to https pages (and localhost): over plain http from
  // another device there is none.
  if (!navigator.mediaDevices?.getUserMedia)
    throw new CaptureError(
      "este navegador no da el micrófono a esta dirección; abre la app por su dirección https",
    );
  active.set(true);
  const asked = performance.now();
  let mic: Mic;
  try {
    mic = takeWarm(settings.browserProcessing) ?? (await openMic(settings.browserProcessing));
  } catch (err) {
    active.set(false);
    throw err instanceof CaptureError ? err : new CaptureError(micErrorText(err));
  }
  const chunks: Float32Array[] = [];
  const max = VOICE_SAMPLE_RATE * MAX_DICTATION_SECONDS;
  let samples = 0;
  let voiced = false;
  let opened: number | null = null;
  // The meter moves about 15 times a second, not once per 8 ms frame.
  let loudest = 0;
  let frames = 0;
  mic.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
    if (opened === null) {
      // A freshly opened microphone first sends about half a second of exact zeros (a USB
      // headset did, every time): nothing is heard yet, and leading silence sent to the model
      // is what turned short phrases English. The take starts with the first real sound.
      if (silentFrame(event.data)) return;
      opened = performance.now();
      onLive();
    }
    if (samples >= max) return;
    chunks.push(event.data);
    samples += event.data.length;
    const level = rms(event.data);
    voiced ||= level >= QUIET;
    loudest = Math.max(loudest, level);
    if (++frames % 8 === 0) {
      onLevel(loudest);
      loudest = 0;
    }
  };
  let done = false;
  const release = () => {
    if (done) return;
    done = true;
    mic.node.port.onmessage = null;
    active.set(false);
    if (settings.warmSeconds <= 0) return close(mic);
    const previous = warm.get();
    if (previous && previous !== mic) close(previous);
    warm.set(mic);
    mic.closeLater = setTimeout(() => close(mic), settings.warmSeconds * 1000);
  };
  const track = mic.stream.getAudioTracks()[0];
  // A warm microphone was already open: this dictation paid nothing to open it.
  const opening = mic.opening;
  mic.opening = null;
  return {
    stop() {
      release();
      return {
        pcm: voiced ? toPcm16(chunks) : null,
        seconds: samples / VOICE_SAMPLE_RATE,
        openMs: opened === null ? null : Math.round(opened - asked),
        mic: track?.label || null,
        rate: track?.getSettings().sampleRate ?? null,
        opening,
      };
    },
    cancel: release,
  };
}

function micErrorText(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError")
    return "el navegador no tiene permiso para el micrófono (o macOS se lo niega)";
  if (name === "NotFoundError") return "no hay ningún micrófono conectado";
  if (name === "NotReadableError") return "otra aplicación tiene el micrófono ocupado";
  return `no se ha podido abrir el micrófono: ${err instanceof Error ? err.message : String(err)}`;
}
