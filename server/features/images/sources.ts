import { homedir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";
import { run } from "../../run.ts";
import { type ImageSource, ImageStore } from "./store.ts";

export type Run = (argv: string[]) => Promise<{ code: number | null; stdout: string }>;

const RUN_TIMEOUT_MS = 5000;

const bunRun: Run = (argv) => run(argv, { timeoutMs: RUN_TIMEOUT_MS });

// Where the OS saves screenshots. macOS keeps a custom place in the screencapture defaults
// (Desktop when unset); Windows saves Win+PrtScn to Pictures\Screenshots, read through the
// shell folder so a Pictures moved to OneDrive is followed. Other platforms have no default.
export async function screenshotFolder({
  platform = process.platform,
  home = homedir(),
  run = bunRun,
}: {
  platform?: NodeJS.Platform;
  home?: string;
  run?: Run;
} = {}): Promise<string | null> {
  if (platform === "darwin") {
    const fallback = join(home, "Desktop");
    const out = await run([
      "/usr/bin/defaults",
      "read",
      "com.apple.screencapture",
      "location",
    ]).catch(() => null);
    const dir = out?.code === 0 ? out.stdout.trim().replace(/^~(?=\/|$)/, home) : "";
    return isAbsolute(dir) ? dir : fallback;
  }
  if (platform === "win32") {
    const out = await run([
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Environment]::GetFolderPath('MyPictures')",
    ]).catch(() => null);
    const pictures = out?.code === 0 ? out.stdout.trim() : "";
    return win32.join(
      win32.isAbsolute(pictures) ? pictures : win32.join(home, "Pictures"),
      "Screenshots",
    );
  }
  return null;
}

// How long the OS's answer is kept: the open picker lists every 2 s, and the user may still
// move the screenshots folder while the server runs.
export const FOLDER_TTL_MS = 60_000;

// The history the app uses: the pasted images, the captured ones (in their own folder inside
// the pasted one) and the screenshots folder: the one in the config, else the OS's.
export const imageStore = (pastesDir: string, configured: string | undefined) =>
  new ImageStore(imageSources(pastesDir, configured), pastesDir);

export function imageSources(
  pastesDir: string,
  configured: string | undefined,
  folder: () => Promise<string | null> = screenshotFolder,
  now = Date.now,
): () => Promise<ImageSource[]> {
  let cached: { at: number; dir: Promise<string | null> } | null = null;
  const osFolder = () => {
    if (!cached || now() - cached.at > FOLDER_TTL_MS) cached = { at: now(), dir: folder() };
    return cached.dir;
  };
  return async () => {
    const dir = configured ?? (await osFolder());
    const sources: ImageSource[] = [
      { id: "pasted", dir: pastesDir, own: true },
      { id: "captured", dir: join(pastesDir, "captures"), own: true },
    ];
    if (dir) sources.push({ id: "folder", dir, own: false });
    return sources;
  };
}
