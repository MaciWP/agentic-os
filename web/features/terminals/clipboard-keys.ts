import type { KeyEventLike } from "../voice/hotkey.ts";

// Copy and paste the way a terminal does on Windows and Linux. On a Mac, Cmd+C and Cmd+V are
// the browser's already, and Ctrl+C and Ctrl+V belong to the program (^C interrupts, ^V is
// Claude's image paste). Elsewhere xterm turns Ctrl+C and Ctrl+V into ^C and ^V and cancels
// the key, so nothing ever reaches the clipboard. With this:
// - Ctrl+C copies while text is selected, as in Windows Terminal; with nothing selected it is
//   still ^C. The view writes the selection to the clipboard itself (terminal-socket.ts).
// - Ctrl+V pastes the clipboard: the browser's paste, which the terminal's paste handler
//   catches (an image goes to the history, text to the program).
// Null leaves the key to xterm.
export type ClipboardKey = "copy" | "paste";

export function clipboardKey(
  e: KeyEventLike,
  { mac, selected }: { mac: boolean; selected: boolean },
): ClipboardKey | null {
  if (mac || !e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return null;
  const key = e.key.toLowerCase();
  if (key === "c" && selected) return "copy";
  if (key === "v") return "paste";
  return null;
}

// OSC 52, a program's own copy: Claude selects with the mouse and sends what it copies this
// way as well as to the Mac's clipboard, so a window on another computer gets it too. `data`
// is `<targets>;<base64>`. Only a write is taken: a read request (`?`) is never answered, so a
// program cannot read the viewer's clipboard. Null when there is nothing to write.
export const OSC52_MAX = 1_000_000;

export function osc52Text(data: string): string | null {
  const payload = data.slice(data.indexOf(";") + 1);
  if (!data.includes(";") || payload === "?" || payload.length > (OSC52_MAX * 4) / 3 + 4)
    return null;
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
