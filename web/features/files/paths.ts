import type { FolderEntry } from "../../../server/features/files/browse.ts";

// The text of a picker's path field, as pure functions: what it means, and how a path is
// written back into it. Paths are POSIX; `home` is the host's, from GET /api/files/places.

export function expandHome(text: string, home: string | null) {
  if (!home) return text;
  if (text === "~") return home;
  return text.startsWith("~/") ? home + text.slice(1) : text;
}

// "/a/b/c" is the folder "/a/b" with "c" typed after it; "/a/b/" is "/a/b" with nothing.
export function splitInput(text: string): { dir: string; tail: string } {
  const slash = text.lastIndexOf("/");
  if (slash < 0) return { dir: "", tail: text };
  return { dir: text.slice(0, slash) || "/", tail: text.slice(slash + 1) };
}

// macOS keeps names decomposed (NFD) and the keyboard types them composed: compare both.
const fold = (s: string) => s.normalize("NFC").toLocaleLowerCase("es");

// The folders whose name starts with what was typed, case ignored.
export function filterEntries(entries: FolderEntry[], tail: string) {
  if (!tail) return entries;
  const typed = fold(tail);
  return entries.filter((e) => fold(e.name).startsWith(typed));
}

// A path for reading: under home it starts with "~".
export function display(path: string, home: string | null) {
  if (!home || home === "/") return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

// The field's text for a folder: its path with a "/" after it, ready to type a name.
export function fieldText(path: string, home: string | null) {
  const shown = display(path, home);
  return shown.endsWith("/") ? shown : `${shown}/`;
}
