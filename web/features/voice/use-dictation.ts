import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { MAX_DICTATION_SECONDS } from "../../../shared/voice.ts";
import { ApiError, api, mutate, unwrap } from "../../api.ts";
import { isMacClient } from "../../keys.ts";
import { errorText } from "../../ui.tsx";
import { audioGraph, type Recording, startRecording } from "./capture.ts";
import { createPendingStore, type PendingStore } from "./pending.ts";

export type DictationPhase = "idle" | "recording" | "transcribing";

// Shorter than this holds no word; "sí" alone takes about 0.3 s.
const MIN_SECONDS = 0.15;
// Shorter cancels are taps and ⌃⌘ shortcuts, not dictations.
const REPORTED_CANCEL_SECONDS = 0.5;

type Outcome = "done" | "too_short" | "silent" | "mic_error" | "failed" | "cancelled";
// How each dictation ended goes to the server log, never what was said. Fire and forget: a
// server without the route must not break dictation.
const report = (outcome: Outcome, seconds: number, extra: Record<string, unknown> = {}) =>
  mutate("/api/voice/report", "POST", {
    outcome,
    seconds: Math.round(seconds * 10) / 10,
    ...extra,
  }).catch(() => {});

export const transcribe = async (pcm: Int16Array) =>
  (await mutate<{ text: string }>("/api/voice/transcribe", "POST", { audio: base64(pcm) })).text;

// Whether dictation is set up; read once per page, it changes only with config.json.
export function useVoice() {
  return useQuery({
    queryKey: ["voice"],
    queryFn: async () => unwrap(await api.api.voice.$get()),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

const base64 = (pcm: Int16Array) => {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export function voiceErrorText(err: unknown): string {
  if (err instanceof ApiError && err.code === "voice_not_configured")
    return "el dictado no está configurado: añade voice.model en config.json";
  if (err instanceof ApiError && err.code === "too_large") return "el dictado es demasiado largo";
  if (err instanceof ApiError && (err.code === "not_running" || err.code === "not_found"))
    return "el terminal ya no está en marcha";
  return errorText(err);
}

const transcriptions = createPendingStore({
  transcribe,
  send: (terminal, text) =>
    mutate(`/api/terminals/${encodeURIComponent(terminal)}/send`, "POST", { text }),
  message: voiceErrorText,
});

// One terminal's dictation. The whole recording is transcribed at once when it stops, and the
// text is pasted at the terminal's prompt; `onText` follows while this view is still open. Cut
// into parts while the user spoke, phrases broke at the cuts and short ones came back worse; the
// user prefers to wait a moment for the whole. The wait outlives the view (pending.ts): leaving
// the terminal drops a recording, never a transcription. A cancel, or a newer dictation, drops
// the answer still on its way. `store` says where the text goes: the terminal, or a store of
// the caller's (the phone's composer draft, which the user reads before sending).
export function useDictation(
  terminal: string,
  onText: (text: string) => void,
  onError: (message: string) => void,
  store: PendingStore = transcriptions,
) {
  const [recordingPhase, setPhase] = useState<"idle" | "recording">("idle");
  const slot = useSyncExternalStore(store.subscribe, () => store.get(terminal));
  const phase: DictationPhase =
    recordingPhase === "recording" ? "recording" : slot.run !== null ? "transcribing" : "idle";
  const [level, setLevel] = useState(0);
  // The microphone gives sound: until then, words said are lost.
  const [live, setLive] = useState(false);
  const voice = useVoice().data;
  const settings = {
    browserProcessing: voice?.browserProcessing ?? true,
    warmSeconds: voice?.warmSeconds ?? 0,
  };
  const [seconds, setSeconds] = useState(0);
  const recording = useRef<Promise<Recording> | null>(null);
  const run = useRef(0);
  const started = useRef(0);
  const mounted = useRef(true);
  const callbacks = useRef({ onText, onError });
  callbacks.current = { onText, onError };

  const stop = async () => {
    const pending = recording.current;
    if (!pending) return;
    recording.current = null;
    const id = run.current;
    let take: ReturnType<Recording["stop"]>;
    try {
      take = (await pending).stop();
    } catch {
      return; // start() already said why.
    }
    if (id !== run.current) return;
    const { pcm, seconds, openMs } = take;
    const mic = {
      ...(openMs === null ? {} : { openMs }),
      ...(take.mic ? { mic: take.mic.slice(0, 120) } : {}),
      ...(take.rate ? { rate: take.rate } : {}),
      ...(take.opening ?? { warm: true }),
    };
    const fail = (outcome: Outcome, message: string) => {
      setPhase("idle");
      report(outcome, seconds, mic);
      callbacks.current.onError(message);
    };
    if (seconds < MIN_SECONDS) return fail("too_short", tooShort());
    if (!pcm) return fail("silent", "no se ha oído nada; revisa el micrófono");
    const released = performance.now();
    const done = store.transcribe(terminal, pcm);
    setPhase("idle");
    const result = await done;
    if (result.outcome === "done") {
      report("done", seconds, { ...mic, waitMs: Math.round(performance.now() - released) });
      if (result.text && mounted.current) callbacks.current.onText(result.text);
    } else if (result.outcome === "failed")
      report("failed", seconds, { ...mic, detail: result.message });
  };

  const start = () => {
    if (recording.current || phase !== "idle") return;
    const id = ++run.current;
    started.current = Date.now();
    setLevel(0);
    setLive(false);
    setSeconds(0);
    setPhase("recording");
    // The model loads while the user speaks.
    mutate("/api/voice/warm", "POST").catch(() => {});
    const pending = startRecording(setLevel, settings, () => {
      if (id === run.current) setLive(true);
    });
    recording.current = pending;
    pending.catch((err: Error) => {
      if (recording.current === pending) recording.current = null;
      if (id !== run.current) return;
      setPhase("idle");
      report("mic_error", 0, { detail: err.message });
      callbacks.current.onError(err.message);
    });
  };

  const cancel = () => {
    run.current++;
    const seconds = (Date.now() - started.current) / 1000;
    // A view opened during another view's wait never recorded: it has no length to report.
    if (started.current > 0 && phase !== "idle" && seconds >= REPORTED_CANCEL_SECONDS)
      report("cancelled", seconds);
    const take = recording.current;
    recording.current = null;
    take?.then((r) => r.cancel()).catch(() => {});
    store.cancel(terminal);
    setPhase("idle");
  };

  // The clock while recording, and the stop at the longest dictation the server takes.
  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(() => {
    if (phase !== "recording") return;
    const timer = setInterval(() => {
      const s = (Date.now() - started.current) / 1000;
      setSeconds(Math.floor(s));
      if (s >= MAX_DICTATION_SECONDS) void stopRef.current();
    }, 250);
    return () => clearInterval(timer);
  }, [phase]);

  // Built before the first dictation, so its first word is not lost while it is built.
  useEffect(() => {
    audioGraph().catch(() => {});
  }, []);

  // A failure shows in this terminal's view, also one opened after the view that dictated left.
  useEffect(() => {
    if (slot.error === null) return;
    const message = store.takeError(terminal);
    if (message) callbacks.current.onError(message);
  }, [slot.error, terminal, store]);

  // A view left mid-recording lets go of the microphone; a transcription goes on.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      run.current++;
      recording.current?.then((r) => r.cancel()).catch(() => {});
    };
  }, []);

  return { phase, live, level, seconds, start, stop, cancel };
}

export type Dictation = ReturnType<typeof useDictation>;

// Too short to transcribe: what to do instead, with the keys this keyboard has.
export const tooShort = (mac = isMacClient()) =>
  `la grabación ha sido demasiado corta; ${mac ? "mantén ⌃⌘ mientras hablas" : "habla un poco más antes de parar"}`;
