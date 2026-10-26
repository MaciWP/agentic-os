import { minSec } from "../../format.ts";
import { Icon } from "../../icons.tsx";
import { isMacClient } from "../../keys.ts";
import { TERM_ICON } from "../terminals/panel.tsx";
import type { Dictation } from "./use-dictation.ts";

// The header's microphone: a click starts and stops, as holding ⌃⌘ does. The overlay below
// says what is going on; the button only turns red while it records.
export function DictationButton({
  dictation,
  configured,
}: {
  dictation: Dictation;
  configured: boolean;
}) {
  const { phase } = dictation;
  // ⌃⌘ is Ctrl+Win off a Mac, which Windows keeps for itself: there the button is the way.
  const mac = isMacClient();
  if (phase === "recording")
    return (
      <button
        type="button"
        className={`${TERM_ICON} bg-bad/15 text-bad hover:bg-bad/25 hover:text-bad`}
        aria-label="Parar el dictado"
        title={`${mac ? "Suelta ⌃⌘ o haz" : "Haz"} clic para insertar el texto; Esc lo descarta`}
        onClick={() => void dictation.stop()}
      >
        <Icon name="mic" size={14} />
      </button>
    );
  if (phase === "transcribing")
    return (
      <span
        className="inline-flex size-6 shrink-0 items-center justify-center text-white/40"
        title="Transcribiendo; Esc lo descarta"
      >
        <Icon name="mic" size={14} />
      </span>
    );
  return (
    <button
      type="button"
      className={`${TERM_ICON} disabled:opacity-40 disabled:hover:bg-transparent`}
      aria-label="Dictar"
      title={
        !configured
          ? "Dictado: añade voice.model en config.json"
          : mac
            ? "Dictar (mantén ⌃⌘)"
            : "Dictar (haz clic para empezar)"
      }
      disabled={!configured}
      onClick={dictation.start}
    >
      <Icon name="mic" size={14} />
    </button>
  );
}

// Louder in the middle, as a voice meter is usually drawn.
const BARS = [
  ["a", 0.45],
  ["b", 0.75],
  ["c", 1],
  ["d", 0.75],
  ["e", 0.45],
] as const;

function Meter({ level }: { level: number }) {
  // Speech sits around 0.02 to 0.15 RMS; a normal voice fills the middle bar.
  const v = Math.min(1, level * 7);
  return (
    <span aria-hidden className="flex h-3.5 items-center gap-[2px]">
      {BARS.map(([id, weight]) => (
        <span
          key={id}
          className="w-[3px] rounded-full bg-bad transition-[height] duration-75"
          style={{ height: `${Math.round(3 + v * weight * 11)}px` }}
        />
      ))}
    </span>
  );
}

// Over the terminal while a dictation runs, where the eyes already are, at the top: the
// dictated words land at the prompt, usually at the bottom. It appears after a moment: a ⌃⌘
// shortcut drops its recording at once and never shows it. Until the microphone gives its first
// sound it says so, since words said before are lost.
const APPEAR =
  "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:delay-150 motion-safe:fill-mode-[both]";

export function DictationOverlay({ dictation }: { dictation: Dictation }) {
  const { phase, live, level, seconds } = dictation;
  if (phase === "idle") return null;
  const recording = phase === "recording";
  return (
    <>
      {recording && (
        <div
          aria-hidden
          className={`pointer-events-none absolute inset-0 z-10 ring-2 ring-bad/60 ring-inset ${APPEAR}`}
        />
      )}
      <div
        role="status"
        className={`pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-3 motion-safe:slide-in-from-top-2 ${APPEAR}`}
      >
        <div className="flex max-w-full items-center gap-2.5 rounded-full border border-white/10 bg-term-header/95 px-3.5 py-1.5 text-[12px] text-term-ink shadow-[var(--shadow-2)]">
          {recording && !live ? (
            // The microphone is still opening: a word said now is lost, so the pill says wait.
            <>
              <span aria-hidden className="size-2 shrink-0 rounded-full bg-white/40" />
              <span className="text-white/75">Abriendo el micro…</span>
            </>
          ) : recording ? (
            <>
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full bg-bad motion-safe:animate-pulse"
              />
              <Meter level={level} />
              <span className="font-medium">Escuchando</span>
              <span aria-hidden className="font-mono text-white/60 tabular-nums">
                {minSec(seconds)}
              </span>
              <span className="hidden whitespace-nowrap text-white/45 @[28rem]:inline">
                Esc para descartar
              </span>
            </>
          ) : (
            <>
              <span
                aria-hidden
                className="size-3 shrink-0 rounded-full border-2 motion-safe:animate-spin border-white/20 border-t-white/70"
              />
              <span className="text-white/75">Transcribiendo…</span>
            </>
          )}
        </div>
      </div>
    </>
  );
}
