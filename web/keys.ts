// Every shortcut takes ⌘ or Ctrl; its label names the one this keyboard has, because on a
// Windows browser ⌘ is no key at all.
export const isMacClient = () =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

export function shortcut(key: string, { shift = false, mac = isMacClient() } = {}): string {
  return mac ? `⌘${shift ? "⇧" : ""}${key}` : `Ctrl+${shift ? "Shift+" : ""}${key}`;
}

// «Siguiente» (features/alerts/signals.tsx): ⌘⇧. or Ctrl+Shift+., told by the key's place, since
// Shift turns "." into ">" or ":" depending on the layout. A terminal lets it through.
export function isNextKey(
  e: Pick<KeyboardEvent, "code" | "shiftKey" | "altKey" | "metaKey" | "ctrlKey">,
  mac = isMacClient(),
): boolean {
  return (
    e.code === "Period" &&
    e.shiftKey &&
    !e.altKey &&
    (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)
  );
}

// Capturar into a terminal: ⌃⌘4 on a Mac, the one AgenticCapture holds anywhere on the Mac
// (it reaches the page only when that helper is not running); Ctrl+Shift+4 elsewhere, since
// Ctrl+Win+number is the taskbar's and Ctrl+Alt is AltGr. Told by the key's place: Shift+4 is
// "$" on a Spanish keyboard.
export function isCaptureKey(
  e: Pick<KeyboardEvent, "code" | "shiftKey" | "altKey" | "metaKey" | "ctrlKey">,
  mac = isMacClient(),
): boolean {
  return (
    e.code === "Digit4" &&
    e.ctrlKey &&
    !e.altKey &&
    (mac ? e.metaKey && !e.shiftKey : e.shiftKey && !e.metaKey)
  );
}

export const captureShortcut = (mac = isMacClient()) => (mac ? "⌃⌘4" : "Ctrl+Shift+4");
