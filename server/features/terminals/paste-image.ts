import { ImageError } from "../images/store.ts";
import type { TerminalInfo, Terminals } from "./contract.ts";

// The path of an image as one typed line, so a shell and Claude Code read one path: on macOS
// spaces and quotes escaped as a Finder drag does, on Windows the path in double quotes (it
// cannot hold one). Control characters never reach a PTY.
export function typedPath(path: string, platform: NodeJS.Platform = process.platform) {
  if (/[\p{Cc}]/u.test(path)) throw new ImageError("path has control characters");
  if (platform === "win32") {
    if (path.includes('"')) throw new ImageError("path has a double quote");
    return `"${path}"`;
  }
  return path.replace(/([ \\'"])/g, "\\$1");
}

// Why a terminal takes no typed text, or null when it does: "Llevar a…" and a capture taken
// with ⌃⌘4 ask the same.
export function inputRefusal(
  t: TerminalInfo,
): { error: "not_running" } | { error: "not_an_input"; detail: string } | null {
  if (t.state !== "running") return { error: "not_running" };
  if (t.harness === "env")
    return { error: "not_an_input", detail: "an env command takes no input" };
  return null;
}

// A kept image's path typed into a terminal, never followed by Enter: false when the terminal
// is gone or takes no input.
export async function typeImage(
  terminals: Pick<Terminals, "get" | "write">,
  id: string,
  path: string,
): Promise<boolean> {
  const t = await terminals.get(id);
  if (!t || inputRefusal(t)) return false;
  return terminals.write(id, typedPath(path), { paste: true });
}
