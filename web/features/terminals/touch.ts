// A touch scroll in xterm 6.1 (beta.304) ends with an inertia glide whose frames carry no
// position. With a program that asked for wheel events (Claude does), each frame becomes a
// wheel report at column and row NaN, `ESC[<65;NaN;NaNM`, and the program reads it as typed
// text. Two layers: the glide gets the last touch's position, and a report that still has no
// position never leaves the browser.

// xterm's private name for a touch gesture step (src/browser/scrollable/touch.ts).
export const GESTURE_CHANGE = "-xterm-gesturechange";

// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what it matches
const BROKEN_REPORT = /\x1b\[<[^Mm\x1b]*NaN[^Mm\x1b]*[Mm]/g;

export const dropBrokenMouseReports = (data: string) =>
  data.includes("NaN") ? data.replace(BROKEN_REPORT, "") : data;

// Claude moves this many lines per wheel report (CLAUDE_CODE_SCROLL_SPEED in
// server/features/terminals/harness.ts; touch.test.ts keeps the two equal).
export const CLAUDE_WHEEL_LINES = 6;

// Fills the position of a gesture step that has none with the last touch's, before xterm (the
// event's target, inside `el`) reads it: capture runs on ancestors even for an event that does
// not bubble. xterm sends one wheel report per row of finger travel; a program that moves
// several lines per report (`wheelLines`) gets the travel divided, so the text follows the
// finger. Returns the cleanup.
export function placeTouchGestures(el: HTMLElement, wheelLines: () => number = () => 1) {
  let last: { clientX: number; clientY: number } | null = null;
  const track = (e: Event) => {
    const touch = (e as TouchEvent).touches?.[0];
    if (touch) last = { clientX: touch.clientX, clientY: touch.clientY };
  };
  const place = (e: Event) => {
    const step = e as Event & { clientX?: unknown; clientY?: unknown; translationY?: unknown };
    if (last && typeof step.clientX !== "number") Object.assign(step, last);
    const lines = wheelLines();
    if (lines > 1 && typeof step.translationY === "number") step.translationY /= lines;
  };
  el.addEventListener("touchstart", track, { capture: true, passive: true });
  el.addEventListener("touchmove", track, { capture: true, passive: true });
  el.addEventListener(GESTURE_CHANGE, place, true);
  return () => {
    el.removeEventListener("touchstart", track, true);
    el.removeEventListener("touchmove", track, true);
    el.removeEventListener(GESTURE_CHANGE, place, true);
  };
}
