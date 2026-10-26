// The real pipeline on speech made with macOS `say`: real Silero, Parakeet, pyannote and
// speaker embeddings, no mocks. Skipped unless TRANSCRIPTS_REAL=1 (it needs the models of
// docs/transcripts.md, `voice.model` in data/config.json and a few minutes):
//   TRANSCRIPTS_REAL=1 bun test server/features/transcripts/integration.test.ts
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../config.ts";
import { openDb } from "../../db.ts";
import { VoiceEngine } from "../voice/engine.ts";
import { livePorts } from "./live.ts";
import { KEEP_AUDIO, Transcripts } from "./runner.ts";
import { TranscriptStore } from "./store.ts";
import { wavOf } from "./test-wav.ts";
import { readPcm, wavInfo } from "./wav.ts";

const real = process.env.TRANSCRIPTS_REAL === "1";
const MODELS = join(import.meta.dir, "../../../data/models");
const LINES: [string, string][] = [
  [
    "Samantha",
    "Good morning everyone, thanks for joining the call today. Let us start with the status of the release.",
  ],
  [
    "Daniel",
    "Sure. The backend migration is finished and we are only waiting for the final review before we deploy it.",
  ],
  [
    "Samantha",
    "Great. Are there any risks with the database change that the team should know about before Friday?",
  ],
  [
    "Daniel",
    "One risk. The new index takes about twenty minutes to build, so we should run it overnight.",
  ],
  [
    "Samantha",
    "Understood. Then I will schedule the deployment for Saturday morning and tell the customer.",
  ],
  [
    "Daniel",
    "Perfect. I will prepare the rollback plan and share it with everybody by tomorrow afternoon.",
  ],
];

async function speak(voice: string, text: string, dir: string, name: string): Promise<Uint8Array> {
  const aiff = join(dir, `${name}.aiff`);
  const wav = join(dir, `${name}.wav`);
  await Bun.spawn(["say", "-v", voice, "-o", aiff, text]).exited;
  await Bun.spawn(["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]).exited;
  const info = await wavInfo(wav);
  return readPcm(wav, info, 0, info.samples);
}
const silence = (seconds: number) => new Uint8Array(Math.round(seconds * 16000) * 2);
const join2 = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

test.skipIf(!real)(
  "two say voices become a two-speaker transcript, linked across blocks",
  async () => {
    const work = mkdtempSync(join(tmpdir(), "transcripts-real-"));
    const dir = join(work, "rec");
    mkdirSync(join(dir, "system"), { recursive: true });
    mkdirSync(join(dir, "mic"), { recursive: true });
    const clips = await Promise.all(LINES.map(([v, t], i) => speak(v, t, work, `s${i}`)));
    const track = (from: number, to: number) =>
      join2(
        clips
          .slice(from, to)
          .flatMap((c) => [silence(1.5), c])
          .concat(silence(1.5)),
      );
    // Two "chunks" of the system track, diarized one block each.
    writeFileSync(join(dir, "system", "000.wav"), wavOf(track(0, 3)));
    writeFileSync(join(dir, "system", "001.wav"), wavOf(track(3, 6)));
    const mine = await speak(
      "Fred",
      "I can confirm that from my side everything is ready.",
      work,
      "me",
    );
    writeFileSync(join(dir, "mic", "000.wav"), wavOf(join2([silence(1), mine, silence(1)])));
    writeFileSync(join(dir, "state.json"), JSON.stringify({ status: "stopped", pid: 1 }));

    const config = loadConfig();
    const voice = new VoiceEngine(config.voice.model as string, { idleMs: 60_000 });
    const models = {
      vad: join(MODELS, "silero_vad.onnx"),
      segmentation: join(MODELS, "sherpa-onnx-pyannote-segmentation-3-0/model.int8.onnx"),
      embedding: join(MODELS, "3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx"),
      bundle: "x",
    };
    const run = async (speakers?: number) => {
      const db = openDb(":memory:");
      const t = new Transcripts(new TranscriptStore(db), livePorts(models, voice, 1), {
        root: work,
        app: "x",
        bundle: "x",
        missing: () => null,
        pollMs: 1000,
        graceMs: 1000,
        now: Date.now,
        id: () => "rec",
        keepAudioMinSeconds: 0,
      });
      // The same audio serves both runs: a ready recording deletes it unless kept.
      writeFileSync(join(work, KEEP_AUDIO), "");
      new TranscriptStore(db).create({ id: "rec", dir, speakers });
      await t.poll();
      return t.detail("rec");
    };
    try {
      const guessed = await run();
      console.log(
        `--- no count: ${guessed.status} ${guessed.error ?? ""} ${guessed.labels.join(", ")}\n${guessed.markdown}`,
      );
      const two = await run(2);
      console.log(`--- count 2: ${two.labels.join(", ")}\n${two.markdown}`);
      expect(two.status).toBe("ready");
      expect(two.labels).toEqual(["me", "Speaker 1", "Speaker 2"]);
      expect(two.markdown).toContain("me:");
      expect(two.markdown.toLowerCase()).toContain("migration");
    } finally {
      voice.stop();
    }
  },
  600_000,
);
