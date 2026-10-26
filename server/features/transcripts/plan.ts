import type { Range } from "./contracts.ts";

export const MIN_SECONDS = 1;
const MAX_SECONDS = 25;
const MAX_GAP = 3;

// What to decode out of the speech the VAD found. Parakeet turns a clip under about a second
// into English guesses, so a short range joins its closer neighbour (gap included) while they
// are at most MAX_GAP apart and the result stays decodable. One left alone is widened to a
// second with the audio around it.
export function decodePlan(speech: Range[], total: number): Range[] {
  const plan = speech.map((r) => ({ ...r }));
  let i = 0;
  while (i < plan.length) {
    const here = plan[i] as Range;
    if (here.end - here.start >= MIN_SECONDS) {
      i++;
      continue;
    }
    const prev = plan[i - 1];
    const next = plan[i + 1];
    const gapBefore = prev ? here.start - prev.end : Number.POSITIVE_INFINITY;
    const gapAfter = next ? next.start - here.end : Number.POSITIVE_INFINITY;
    const useNext = gapAfter < gapBefore;
    const other = useNext ? next : prev;
    if (other && Math.min(gapBefore, gapAfter) <= MAX_GAP) {
      const joined = {
        start: Math.min(here.start, other.start),
        end: Math.max(here.end, other.end),
      };
      if (joined.end - joined.start <= MAX_SECONDS) {
        i = useNext ? i : i - 1;
        plan.splice(i, 2, joined);
        continue;
      }
    }
    const start = Math.max(
      0,
      Math.min(here.start - (MIN_SECONDS - (here.end - here.start)) / 2, total - MIN_SECONDS),
    );
    plan[i] = { start, end: Math.min(total, start + MIN_SECONDS) };
    i++;
  }
  return plan;
}
