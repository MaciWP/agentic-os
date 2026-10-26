import { SAMPLE_RATE } from "./contracts.ts";

export type Wav = { dataOffset: number; samples: number };

// Where the samples of a 16 kHz mono PCM16 file start and how many there are. The header's
// chunks are walked, not assumed to be 44 bytes; a writer that left the data size at 0 or
// 0xFFFFFFFF is read to the end of the file.
export async function wavInfo(path: string): Promise<Wav> {
  const file = Bun.file(path);
  const head = new DataView(await file.slice(0, 4096).arrayBuffer());
  const tag = (at: number) =>
    at + 4 <= head.byteLength ? String.fromCharCode(...new Uint8Array(head.buffer, at, 4)) : "";
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error(`${path} is not a WAV file`);
  let fmtOk = false;
  for (let at = 12; at + 8 <= head.byteLength; ) {
    const size = head.getUint32(at + 4, true);
    if (tag(at) === "fmt ") {
      fmtOk =
        head.getUint16(at + 8, true) === 1 &&
        head.getUint16(at + 10, true) === 1 &&
        head.getUint32(at + 12, true) === SAMPLE_RATE &&
        head.getUint16(at + 22, true) === 16;
    } else if (tag(at) === "data") {
      if (!fmtOk) throw new Error(`${path} is not 16 kHz mono PCM16`);
      const dataOffset = at + 8;
      const room = file.size - dataOffset;
      return { dataOffset, samples: Math.floor((size === 0 || size > room ? room : size) / 2) };
    }
    at += 8 + size + (size % 2);
  }
  throw new Error(`${path} has no audio data`);
}

// Raw PCM16 bytes of `count` samples from sample `from`, short at the end of the file.
export async function readPcm(path: string, wav: Wav, from: number, count: number) {
  const first = Math.min(Math.max(from, 0), wav.samples);
  const last = Math.min(first + Math.max(count, 0), wav.samples);
  const begin = wav.dataOffset + first * 2;
  return new Uint8Array(
    await Bun.file(path)
      .slice(begin, begin + (last - first) * 2)
      .arrayBuffer(),
  );
}

export function toFloat(pcm: Uint8Array): Float32Array {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const out = new Float32Array(pcm.byteLength >> 1);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}
