import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SAMPLE_RATE } from "./contracts.ts";

// A 16 kHz mono PCM16 WAV of `seconds` of a quiet tone, for tests and the integration check.
export function wavBytes(seconds: number): Uint8Array {
  const samples = Math.round(seconds * SAMPLE_RATE);
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < samples; i++) view.setInt16(i * 2, Math.round(Math.sin(i / 20) * 3000), true);
  return wavOf(pcm);
}

// A WAV around raw 16 kHz mono PCM16 bytes.
export function wavOf(pcm: Uint8Array): Uint8Array {
  const samples = pcm.length / 2;
  const out = new Uint8Array(44 + samples * 2);
  const view = new DataView(out.buffer);
  const tag = (at: number, s: string) => {
    for (const [i, c] of [...s].entries()) out.set([c.charCodeAt(0)], at + i);
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, samples * 2, true);
  out.set(pcm, 44);
  return out;
}

export function writeWav(path: string, seconds: number) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, wavBytes(seconds));
}
