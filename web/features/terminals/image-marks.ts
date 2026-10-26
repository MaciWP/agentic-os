import { MAX_BRING_IMAGES } from "../../../shared/terminals.ts";

// The image history's marks and keys, apart from React so the tests read them alone.

const COLS = 4;

// The marks after a click: off if on, on if there is room, else null (the cap is reached).
export function toggleMark(marked: string[], image: string): string[] | null {
  if (marked.includes(image)) return marked.filter((m) => m !== image);
  return marked.length >= MAX_BRING_IMAGES ? null : [...marked, image];
}

// Images just kept go first, marked, in their order; the oldest marks drop past the cap.
export const markAll = (marked: string[], images: string[]) =>
  [...images, ...marked.filter((m) => !images.includes(m))].slice(0, MAX_BRING_IMAGES);

// Arrow keys over a grid of COLS columns: the next index, kept inside the grid; from outside
// it, the first.
const STEP: Partial<Record<string, number>> = {
  ArrowRight: 1,
  ArrowLeft: -1,
  ArrowDown: COLS,
  ArrowUp: -COLS,
};
export function stepFocus(at: number, key: string, count: number): number | null {
  const step = STEP[key];
  if (!step || count === 0) return null;
  return at < 0 ? 0 : Math.min(count - 1, Math.max(0, at + step));
}
