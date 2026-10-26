import { z } from "zod";
import { storageKey } from "./storage.ts";
import { createStore, useStore } from "./store.ts";

// A short chime made with Web Audio, so there is no sound file to ship. Browsers keep audio off
// until the page gets a click or a key, so the context is made, or resumed, on the first one;
// until then the chime stays silent and `useChimeReady` says so.
const audio = createStore<AudioContext | null>(null);
const ready = createStore(false);

const wake = () => {
  try {
    if (!audio.get()) {
      const ctx = new AudioContext();
      // The system can suspend it again (a device change, sleep): the header follows.
      ctx.onstatechange = () => ready.set(ctx.state === "running");
      audio.set(ctx);
    }
    void audio.get()?.resume();
  } catch {
    // No Web Audio here: the visual cues still show.
  }
};

// Returns the cleanup.
export function armChime(): () => void {
  window.addEventListener("pointerdown", wake, true);
  window.addEventListener("keydown", wake, true);
  return () => {
    window.removeEventListener("pointerdown", wake, true);
    window.removeEventListener("keydown", wake, true);
  };
}

// One tune per kind of wait, told apart by their shape: three low notes when something failed,
// three rising ones when an agent asks, three falling ones when it finished its turn, one soft
// note when an env command is done. Listed from the most urgent, as the Mesas count them
// (`WAIT_KINDS`, features/terminals/panel.tsx).
export const TUNES = ["failed", "asks", "turn", "done"] as const;
export type Tune = (typeof TUNES)[number];
export const TUNE_NOTES: Record<Tune, { notes: number[]; gain: number }> = {
  failed: { notes: [440, 349.23, 261.63], gain: 0.5 },
  asks: { notes: [659.25, 880, 1318.5], gain: 0.5 },
  turn: { notes: [1318.5, 987.77, 783.99], gain: 0.45 },
  done: { notes: [880], gain: 0.25 },
};
export const TUNE_LABEL: Record<Tune, string> = {
  failed: "Ha fallado",
  asks: "Te pregunta",
  turn: "Ha terminado",
  done: "Listo",
};

// The user's volume, 0 to 1, kept in this browser.
const stored = storageKey("aos.chime.volume", {
  schema: z.coerce.number().min(0).max(1),
  fallback: 0.8,
});
const volume = createStore(stored.get());
export const useVolume = () => useStore(volume);
export function setVolume(v: number) {
  volume.set(v);
  stored.set(v);
}

// One chime per burst: within GAP_MS another is dropped unless it is more urgent than the last.
const GAP_MS = 3000;
const last = createStore<{ at: number; tune: Tune }>({
  at: Number.NEGATIVE_INFINITY,
  tune: "done",
});
export function shouldPlay(now: number, tune: Tune, before: { at: number; tune: Tune }): boolean {
  return now - before.at >= GAP_MS || TUNES.indexOf(tune) < TUNES.indexOf(before.tune);
}

// Whether a chime can sound now; until the first click or key it cannot.
export const useChimeReady = () => useStore(ready);

// `test` plays at once, past the burst rule: the user asked to hear it.
export function chime(tune: Tune, test = false): void {
  const ctx = audio.get();
  // The click on «Probar» is the one that wakes the audio: play once it is up.
  if (test && ctx && ctx.state !== "running") {
    void ctx.resume().then(() => ctx.state === "running" && chime(tune, true));
    return;
  }
  if (ctx?.state !== "running") return;
  const now = performance.now();
  if (!test && !shouldPlay(now, tune, last.get())) return;
  if (!test) last.set({ at: now, tune });
  const { notes, gain } = TUNE_NOTES[tune];
  const peak = Math.max(0.0002, gain * volume.get());
  const start = ctx.currentTime;
  for (const [i, freq] of notes.entries()) {
    const at = start + i * 0.15;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = freq;
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(peak, at + 0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
    osc.connect(env).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.55);
  }
}
