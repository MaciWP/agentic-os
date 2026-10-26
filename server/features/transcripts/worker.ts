// Speech detection and speaker separation in a process of their own (see analysis.ts): sherpa
// blocks while it works, so it never runs inside the server. One job per process:
//   worker.ts vad <json>      → [{start,end}] speech ranges of one chunk, in seconds
//   worker.ts diarize <json>  → [{start,end,speaker}] turns of the whole system track
// The answer is one JSON line on stdout; a failure is a message on stderr and a non-zero exit.
import { OfflineSpeakerDiarization, SpeakerEmbeddingExtractor, Vad } from "sherpa-onnx-node";
import { z } from "zod";
import { SAMPLE_RATE, type Turn } from "./contracts.ts";
import { foldCrumbs, relabel, SpeakerLinker } from "./link.ts";
import { readPcm, toFloat, wavInfo } from "./wav.ts";

export const VadJob = z.strictObject({ wav: z.string(), model: z.string() });
export const DiarizeJob = z.strictObject({
  // The system track's chunks in order, each with where it starts in the recording.
  files: z.array(z.strictObject({ path: z.string(), offset: z.number() })).min(1),
  segmentation: z.string(),
  embedding: z.string(),
  speakers: z.number().int().positive().nullable(),
  // Chunks per block: a block is diarized whole, 3 h never sit in memory at once.
  blockChunks: z.number().int().positive(),
  // Only to tune these on kept audio (docs/transcripts.md); the server never sends them.
  tuning: z
    .strictObject({
      threshold: z.number().positive(),
      sameVoice: z.number().min(-1).max(1),
      minVoiceSeconds: z.number().min(0),
    })
    .partial()
    .optional(),
});

// Two threads at most: the agents come first.
const THREADS = 2;
// sherpa's clustering distance: a smaller one gives more speakers.
const THRESHOLD = 0.5;
// Two voices are the same speaker above this cosine similarity of their embeddings.
const SAME_VOICE = 0.5;
// A block's speaker with less speech than this is a crumb of someone else (foldCrumbs).
const MIN_VOICE_SECONDS = 20;
// A speaker's voiceprint comes from at most this much of their speech in the block.
const VOICEPRINT_SECONDS = 30;

const readFloats = async (path: string) => {
  const wav = await wavInfo(path);
  return toFloat(await readPcm(path, wav, 0, wav.samples));
};

async function vad({ wav, model }: z.infer<typeof VadJob>) {
  const detector = new Vad(
    {
      sileroVad: {
        model,
        threshold: 0.5,
        minSilenceDuration: 0.5,
        minSpeechDuration: 0.25,
        windowSize: 512,
        maxSpeechDuration: 25,
      },
      sampleRate: SAMPLE_RATE,
      numThreads: 1,
      provider: "cpu",
      debug: 0,
    },
    60,
  );
  const ranges: { start: number; end: number }[] = [];
  const drain = () => {
    while (!detector.isEmpty()) {
      const { start, samples } = detector.front(false);
      ranges.push({ start: start / SAMPLE_RATE, end: (start + samples.length) / SAMPLE_RATE });
      detector.pop();
    }
  };
  const samples = await readFloats(wav);
  for (let at = 0; at < samples.length; at += 512) {
    detector.acceptWaveform(samples.subarray(at, at + 512));
    drain();
  }
  detector.flush();
  drain();
  return ranges;
}

async function diarize(job: z.infer<typeof DiarizeJob>) {
  const tuning = {
    threshold: THRESHOLD,
    sameVoice: SAME_VOICE,
    minVoiceSeconds: MIN_VOICE_SECONDS,
    ...job.tuning,
  };
  const blocks: (typeof job.files)[] = [];
  for (let i = 0; i < job.files.length; i += job.blockChunks)
    blocks.push(job.files.slice(i, i + job.blockChunks));
  const sd = new OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: job.segmentation }, numThreads: THREADS, debug: 0 },
    embedding: { model: job.embedding, numThreads: THREADS, debug: 0 },
    // A known count steers the clustering only when one block holds everything; across blocks
    // it is applied after linking, as a block may have fewer speakers than the meeting.
    clustering: {
      numClusters: blocks.length === 1 && job.speakers ? job.speakers : -1,
      threshold: tuning.threshold,
    },
    minDurationOn: 0.3,
    minDurationOff: 0.5,
  });
  const extractor = new SpeakerEmbeddingExtractor({
    model: job.embedding,
    numThreads: THREADS,
    debug: 0,
    provider: "cpu",
  });
  const linker = new SpeakerLinker(tuning.sameVoice);
  const turns: Turn[] = [];
  for (const block of blocks) {
    const parts = await Promise.all(block.map((f) => readFloats(f.path)));
    const audio = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      audio.set(p, at);
      at += p.length;
    }
    const base = (block[0] as { offset: number }).offset;
    const local = sd.process(audio);
    const speakers = [...new Set(local.map((t) => t.speaker))];
    const voices: Float32Array[] = [];
    const kept: number[] = [];
    const seconds: number[] = [];
    for (const speaker of speakers) {
      const own = local.filter((t) => t.speaker === speaker);
      const speech = own.map((t) =>
        audio.subarray(Math.floor(t.start * SAMPLE_RATE), Math.floor(t.end * SAMPLE_RATE)),
      );
      const cap = VOICEPRINT_SECONDS * SAMPLE_RATE;
      const stream = extractor.createStream();
      let used = 0;
      for (const piece of speech) {
        if (used >= cap) break;
        const part = piece.subarray(0, cap - used);
        stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: part });
        used += part.length;
      }
      stream.inputFinished();
      // Too little speech for a voiceprint: its turns are dropped, a second of talk at most.
      if (!extractor.isReady(stream)) continue;
      voices.push(extractor.compute(stream, false));
      kept.push(speaker);
      seconds.push(own.reduce((n, t) => n + t.end - t.start, 0));
    }
    // Only the block's real voices are linked: a crumb's few seconds make a poor voiceprint.
    const into = foldCrumbs(voices, seconds, tuning.minVoiceSeconds);
    const heads = [...new Set(into)];
    const ids = linker.link(heads.map((i) => voices[i] as Float32Array));
    for (const t of local) {
      const i = kept.indexOf(t.speaker);
      if (i !== -1) {
        const speaker = ids[heads.indexOf(into[i] as number)] as number;
        turns.push({ start: base + t.start, end: base + t.end, speaker });
      }
    }
  }
  const into = job.speakers && linker.size > job.speakers ? linker.mergeDown(job.speakers) : null;
  return relabel(into ? turns.map((t) => ({ ...t, speaker: into[t.speaker] as number })) : turns);
}

if (import.meta.main) {
  const [op, json] = process.argv.slice(2);
  try {
    const job = JSON.parse(json ?? "null");
    const out =
      op === "vad"
        ? await vad(VadJob.parse(job))
        : op === "diarize"
          ? await diarize(DiarizeJob.parse(job))
          : null;
    if (!out) throw new Error("usage: worker.ts vad|diarize <json>");
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
