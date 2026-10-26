import { type Segment, SPEAKER_ME, SPEAKER_OTHERS, type Turn, type Words } from "./contracts.ts";

export const speakerLabel = (speaker: number) => `Speaker ${speaker + 1}`;

// Who talks during `words` on the system track: the speaker with the most overlap, or the
// nearest turn when the diarizer found none there (it drops very short ones).
export function speakerAt(turns: Turn[], words: Words): number | null {
  const overlap = new Map<number, number>();
  for (const t of turns) {
    const o = Math.min(t.end, words.end) - Math.max(t.start, words.start);
    if (o > 0) overlap.set(t.speaker, (overlap.get(t.speaker) ?? 0) + o);
  }
  const best = [...overlap].sort((a, b) => b[1] - a[1])[0];
  if (best) return best[0];
  const mid = (words.start + words.end) / 2;
  const distance = (t: Turn) => Math.abs((t.start + t.end) / 2 - mid);
  return [...turns].sort((a, b) => distance(a) - distance(b))[0]?.speaker ?? null;
}

// Both tracks in one timeline. The microphone is the user ("me"); the system track is everyone
// else, named by the diarization (null: not run yet, so all are "others") and then by the
// names the user gave.
export function mergeTracks(
  mic: Words[],
  system: Words[],
  turns: Turn[] | null,
  names: Record<string, string> = {},
): Segment[] {
  const named = (label: string) => names[label] || label;
  const own = mic.map((w) => ({ ...w, speaker: named(SPEAKER_ME) }));
  const others = system.map((w) => {
    if (!turns) return { ...w, speaker: named(SPEAKER_OTHERS) };
    const who = speakerAt(turns, w);
    return { ...w, speaker: named(who === null ? "Speaker ?" : speakerLabel(who)) };
  });
  return [...own, ...others].sort((a, b) => a.start - b.start || a.end - b.end);
}

const pad = (n: number) => String(Math.floor(n)).padStart(2, "0");
export const stamp = (seconds: number) =>
  `${pad(seconds / 3600)}:${pad((seconds % 3600) / 60)}:${pad(seconds % 60)}`;

export const markdown = (segments: Segment[]) =>
  segments.map((s) => `[${stamp(s.start)}] ${s.speaker}: ${s.text}`).join("\n");
