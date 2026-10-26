import { readdirSync } from "node:fs";
import { join } from "node:path";
import { SAMPLE_RATE, type Track } from "./contracts.ts";
import { wavInfo } from "./wav.ts";

export type Chunk = { track: Track; idx: number; offset: number; duration: number };

export const chunkPath = (dir: string, track: Track, idx: number) =>
  join(dir, track, `${String(idx).padStart(3, "0")}.wav`);

// The closed chunks of one track, in order, each with where it starts in the recording: the
// sum of the lengths before it, so a short last chunk or a gap in the numbering shifts nothing
// else. The helper renames a chunk to NNN.wav only once it is closed; `.part` files are still
// being written and never match.
export async function closedChunks(dir: string, track: Track): Promise<Chunk[]> {
  let names: string[];
  try {
    names = readdirSync(join(dir, track));
  } catch {
    return [];
  }
  const idxs = names
    .flatMap((n) => /^(\d+)\.wav$/.exec(n)?.[1] ?? [])
    .map(Number)
    .sort((a, b) => a - b);
  const chunks: Chunk[] = [];
  let offset = 0;
  for (const idx of idxs) {
    const duration = (await wavInfo(chunkPath(dir, track, idx))).samples / SAMPLE_RATE;
    chunks.push({ track, idx, offset, duration });
    offset += duration;
  }
  return chunks;
}
