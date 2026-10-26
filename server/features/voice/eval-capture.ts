// Real-voice test set, opt-in (`voice.evalCapture`): each dictation is kept as a WAV and what
// the model heard, so engines and settings can be compared on the user's own voice
// (`scripts/voice-bench.ts`). Off, nothing is written. The folder lives in `data/`, outside git.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { VOICE_SAMPLE_RATE } from "../../../shared/voice.ts";

export type KeepDictation = (pcm: Buffer, heard: { raw: string; text: string }) => Promise<void>;

// A 16-bit mono WAV around the PCM the browser sent.
export function wav(pcm: Buffer, rate = VOICE_SAMPLE_RATE): Buffer {
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

export function keepDictations(dir: string, now = () => new Date()): KeepDictation {
  return async (pcm, heard) => {
    await mkdir(dir, { recursive: true });
    const id = now().toISOString().replace(/[:.]/g, "-");
    await writeFile(join(dir, `${id}.wav`), wav(pcm));
    await writeFile(join(dir, `${id}.json`), `${JSON.stringify(heard)}\n`);
  };
}
