import type { KeyboardEvent } from "react";

// The arrows move the focus to the nearest item that way, by where the items are drawn, so a
// grid that wraps and a canvas move the same. `focus` puts it there (the canvas moves its
// camera instead of letting the browser scroll).
export function arrowFocus(
  e: KeyboardEvent<HTMLElement>,
  selector: string,
  focus = (el: HTMLElement) => el.focus(),
) {
  const step = (
    { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as const
  )[e.key as "ArrowLeft"];
  const from = e.target as HTMLElement;
  if (!step || e.altKey || e.metaKey || e.ctrlKey || !from.matches(selector)) return;
  const [sx, sy] = step;
  const a = from.getBoundingClientRect();
  let best: HTMLElement | null = null;
  let score = Number.POSITIVE_INFINITY;
  for (const el of e.currentTarget.querySelectorAll<HTMLElement>(selector)) {
    const b = el.getBoundingClientRect();
    const dx = b.left + b.width / 2 - (a.left + a.width / 2);
    const dy = b.top + b.height / 2 - (a.top + a.height / 2);
    const along = dx * sx + dy * sy;
    if (el === from || along <= 1) continue;
    const s = along + 2 * Math.abs(dx * sy + dy * sx);
    if (s < score) {
      score = s;
      best = el;
    }
  }
  if (!best) return;
  e.preventDefault();
  focus(best);
}
