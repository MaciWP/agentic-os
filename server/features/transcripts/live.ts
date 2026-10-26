import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../config.ts";
import { run } from "../../run.ts";
import { parseEnvelope } from "../mac/run.ts";
import type { VoiceEngine } from "../voice/engine.ts";
import { detectSpeech, diarizeTrack } from "./analysis.ts";
import { inCallOf } from "./calls.ts";
import type { Ports } from "./runner.ts";

// Chunks diarized together: 6 × 5 minutes, so a 3 h meeting is never in memory at once.
const BLOCK_CHUNKS = 6;

export function livePorts(
  config: Config["transcripts"],
  voice: VoiceEngine | undefined,
  blockChunks = BLOCK_CHUNKS,
  // The capture helper: given, calls are detected and recorded on their own.
  app?: string,
): Ports {
  return {
    // `probe` needs no grant, so it runs directly, not through Launch Services.
    inCall: app
      ? async () => {
          const out = await run([join(app, "Contents", "MacOS", "AgenticAudio"), "probe"], {
            timeoutMs: 5_000,
          });
          if (out.code !== 0) throw new Error(`probe exited ${out.code}`);
          return inCallOf(parseEnvelope(out.stdout.trim()), config.bundle);
        }
      : undefined,
    decode: async (pcm) => {
      if (!voice) throw new Error("voice.model is not configured");
      return (await voice.transcribe(pcm)).text;
    },
    vad: (wav) => detectSpeech({ wav, model: config.vad as string }),
    diarize: (files, speakers) =>
      diarizeTrack({
        files,
        segmentation: config.segmentation as string,
        embedding: config.embedding as string,
        speakers,
        blockChunks,
      }),
    alive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return (err as { code?: string }).code === "EPERM";
      }
    },
    launch: async (argv) => {
      const out = await run(argv, { timeoutMs: 15_000 });
      return out.code ?? -1;
    },
  };
}

// Why recording cannot start here, or null.
export function missingPieces(
  config: Config["transcripts"],
  voice: VoiceEngine | undefined,
  app: string,
): string | null {
  if (!voice) return "add voice.model to config.json: the transcripts use the same speech model";
  for (const key of ["vad", "segmentation", "embedding"] as const)
    if (!config[key]) return `add transcripts.${key} to config.json (see docs/transcripts.md)`;
  if (!existsSync(app)) return `the capture helper is missing: ${app}`;
  return null;
}
