import { useState } from "react";
import { createStore, useStore } from "./store.ts";

// Motion that keeps its meaning without costing a compositor frame every vsync while it shows.
// Measured on 2026-10-08 (e2e/ui-motion-perf.e2e.ts, data/evidence/ui-motion): a Mesa with
// three working agents and three waiting drew 60 frames/s with endless CSS loops (GPU process
// 21 % of a core); with the pulses bounded and the spinners on the shared timer below, 8 frames/s
// (GPU 1.2 %). Spinners in 8 CSS steps still drew 24, since each steps at its own moment.

const reduced = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

// A status that pulses only a few times (`animate-attention`, web/tokens.css) pulses again when
// there is something new to see: its count grew, or the user came back to the page. Used as the
// element's `key`, so React mounts it again and the animation starts over.

// What a count went through: how many times it grew. It never counts a fall, so a status the
// user cleared stays still.
export type Rise = { n: number; rise: number };
export const nextRise = (s: Rise, n: number): Rise =>
  n === s.n ? s : { n, rise: n > s.n ? s.rise + 1 : s.rise };

// Times the page became visible again.
const shown = createStore(0);

export function useRise(n: number) {
  const [s, setS] = useState<Rise>({ n, rise: 0 });
  const next = nextRise(s, n);
  if (next !== s) setS(next);
  return `${next.rise}.${useStore(shown)}`;
}

// The working spinners turn together, 45° eight times a second, on one timer: every one steps
// in the same frame, so a Mesa of agents costs 8 frames a second however many show. The timer
// runs only while one shows, the page is visible and the user has not asked for less motion;
// then the icon stands still and the phase's word and colour carry it.
const spinners = new Set<HTMLElement>();
const step = createStore(0);
const timer = createStore<ReturnType<typeof setInterval> | null>(null);

const angle = () => (reduced() ? "" : `rotate(${step.get() * 45}deg)`);
const paint = () => {
  for (const el of spinners) el.style.transform = angle();
};

export function turn() {
  step.update((s) => (s + 1) % 8);
  paint();
}

function sync() {
  const run = spinners.size > 0 && !hidden() && !reduced();
  const t = timer.get();
  if (run && t === null) timer.set(setInterval(turn, 125));
  if (!run && t !== null) {
    clearInterval(t);
    timer.set(null);
  }
}

// A React 19 ref callback: `ref={spinRef}` on the element to turn; React calls the returned
// cleanup when it goes.
export function spinRef(el: HTMLElement) {
  spinners.add(el);
  el.style.transform = angle();
  sync();
  return () => {
    spinners.delete(el);
    // The span may stay to show the next phase's icon: upright.
    el.style.transform = "";
    sync();
  };
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") shown.update((v) => v + 1);
    sync();
  });
  matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", () => {
    paint();
    sync();
  });
}
