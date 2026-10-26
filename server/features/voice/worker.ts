// The speech model in its own process (see engine.ts). It prints `{"ready":true}` once the
// model is loaded, then reads one request per stdin line, `{"id","pcm"}` with base64 PCM16,
// and answers each with `{"id","text","ms"}` or `{"id","error"}`. It ends when stdin closes,
// which happens when the server ends too, even if it is killed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OfflineRecognizer } from "sherpa-onnx-node";
import { VOICE_SAMPLE_RATE } from "../../../shared/voice.ts";
import { errorMessage } from "../../error-message.ts";
import { log } from "../../log.ts";
import { WorkerOptions } from "./engine.ts";
import { hotwords, vocabulary } from "./pieces.ts";

const dir = process.argv[2];
if (!dir) {
  log("voice").error("usage: worker.ts <model folder> [options json]");
  process.exit(2);
}
const { terms, boost } = WorkerOptions.parse(JSON.parse(process.argv[3] ?? "{}"));
// Three models fit, told apart by their files: Parakeet (a transducer, with a joiner), Canary
// (an encoder and a decoder), whose language is fixed to Spanish instead of guessed, and
// Qwen3-ASR (with a conv frontend), which reads the terms as context in its prompt.
const parakeet = existsSync(join(dir, "joiner.int8.onnx"));
const qwen3 = existsSync(join(dir, "conv_frontend.onnx"));
const encoder = join(dir, "encoder.int8.onnx");
const decoder = join(dir, "decoder.int8.onnx");
// Parakeet boosts terms only as its own tokens, and only with beam search; without terms the
// greedy search gives the same text.
const boosted = parakeet && terms.length > 0;
const pieces = boosted
  ? hotwords(terms, vocabulary(readFileSync(join(dir, "tokens.txt"), "utf8")))
  : "";
const modelConfig = parakeet
  ? {
      transducer: { encoder, decoder, joiner: join(dir, "joiner.int8.onnx") },
      modelType: "nemo_transducer",
      tokens: join(dir, "tokens.txt"),
    }
  : qwen3
    ? {
        qwen3Asr: {
          convFrontend: join(dir, "conv_frontend.onnx"),
          encoder,
          decoder,
          tokenizer: join(dir, "tokenizer"),
          hotwords: terms.join(","),
        },
        tokens: "",
      }
    : {
        canary: { encoder, decoder, srcLang: "es", tgtLang: "es", usePnc: 1 },
        tokens: join(dir, "tokens.txt"),
      };
const recognizer = new OfflineRecognizer({
  featConfig: { sampleRate: VOICE_SAMPLE_RATE, featureDim: parakeet ? 80 : 128 },
  modelConfig: {
    ...modelConfig,
    // Two threads decode 10 s of speech in about 0.4 s on an M3 and leave the rest to the agents.
    numThreads: 2,
    provider: "cpu",
    debug: 0,
  },
  ...(boosted
    ? { decodingMethod: "modified_beam_search", maxActivePaths: 4, hotwordsScore: boost }
    : {}),
});
const say = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
say({ ready: true });

for await (const line of console) {
  if (!line.trim()) continue;
  let id: unknown = null;
  try {
    const req = JSON.parse(line) as { id: unknown; pcm: unknown };
    id = req.id;
    if (typeof id !== "number" || typeof req.pcm !== "string") throw new Error("bad request");
    const bytes = Buffer.from(req.pcm, "base64");
    const samples = new Float32Array(bytes.length >> 1);
    for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2) / 32768;
    const start = performance.now();
    const stream = pieces ? recognizer.createStream(pieces) : recognizer.createStream();
    stream.acceptWaveform({ sampleRate: VOICE_SAMPLE_RATE, samples });
    recognizer.decode(stream);
    say({ id, text: recognizer.getResult(stream).text, ms: Math.round(performance.now() - start) });
  } catch (err) {
    say({ id: typeof id === "number" ? id : -1, error: errorMessage(err) });
  }
}
