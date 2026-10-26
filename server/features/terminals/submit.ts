import type { PasteMode } from "./contract.ts";

export type Writer = {
  write(id: string, data: string, opts?: { paste?: PasteMode }): boolean | Promise<boolean>;
};

// Types text into an agent's prompt as one paste, then presses Enter once the paste has
// landed, so a multi-line text is one message and never a run of Enters.
export async function submit(terminals: Writer, id: string, text: string, enterDelay = 150) {
  if (!(await terminals.write(id, text, { paste: "only" })))
    throw new Error("terminal refused the paste");
  await Bun.sleep(enterDelay);
  if (!(await terminals.write(id, "\r"))) throw new Error("terminal ended before Enter");
}
