// Compares speech engines and settings on the user's own voice: the dictations kept in
// data/voice-eval while `voice.evalCapture` is on (see docs/voice.md). The first run writes
// refs.tsv with what the model heard; correct the wrong words there, then run it again.
//
//   bun scripts/voice-bench.ts
//
// For each setting it prints the word error rate, how many glossary terms said were written
// right, how many were written but not said, and the decode time per second of audio.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DATA_DIR, loadConfig } from "../server/config.ts";
import { VoiceEngine, type WorkerOptions } from "../server/features/voice/engine.ts";
import { glossary, normalize } from "../server/features/voice/normalize.ts";
import { VOICE_SAMPLE_RATE } from "../shared/voice.ts";

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

// Word-level edit distance over the reference length.
export function wordErrors(ref: string, hyp: string): { errors: number; words: number } {
  const r = words(ref);
  const h = words(hyp);
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const row = [i];
    for (let j = 1; j <= h.length; j++)
      row[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (r[i - 1] === h[j - 1] ? 0 : 1),
      );
    prev = row;
  }
  return { errors: prev[h.length] ?? 0, words: r.length };
}

const has = (text: string, term: string) =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`,
    "iu",
  ).test(text);

// Terms in the reference written right (`hit`), and terms written that were never said.
export function termScore(ref: string, hyp: string, terms: string[]) {
  let said = 0;
  let hit = 0;
  let invented = 0;
  for (const term of terms) {
    if (has(ref, term)) {
      said++;
      if (has(hyp, term)) hit++;
    } else if (has(hyp, term)) invented++;
  }
  return { said, hit, invented };
}

export function readRefs(tsv: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const line of tsv.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab > 0) refs.set(line.slice(0, tab), line.slice(tab + 1).trim());
  }
  return refs;
}

type Run = { label: string; model: string; words: WorkerOptions };

async function main() {
  const config = loadConfig();
  const dir = join(DATA_DIR, "voice-eval");
  const model = config.voice.model;
  if (!model) throw new Error("voice.model is not set in data/config.json");
  const ids = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".wav"))
        .map((f) => basename(f, ".wav"))
        .sort()
    : [];
  if (!ids.length) throw new Error(`no dictations in ${dir}: turn on voice.evalCapture first`);
  const refsPath = join(dir, "refs.tsv");
  if (!existsSync(refsPath)) {
    const heard = ids.map((id) => {
      const kept = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as { text: string };
      return `${id}\t${kept.text}`;
    });
    writeFileSync(refsPath, `${heard.join("\n")}\n`);
    console.log(`Wrote ${refsPath}: correct each line to what you said, then run again.`);
    return;
  }
  const refs = readRefs(readFileSync(refsPath, "utf8"));
  const terms = glossary({ ...config.voice, jiraProject: config.jira?.project });
  const fix = (t: string) =>
    normalize(t, { replace: config.voice.replace, jiraProject: config.jira?.project });
  const others = readdirSync(dirname(model))
    .map((f) => join(dirname(model), f))
    .filter((m) => m !== model && existsSync(join(m, "encoder.int8.onnx")));
  const runs: Run[] = [
    { label: `${basename(model)} sin glosario`, model, words: {} },
    ...[3, 5, 8].map((boost) => ({
      label: `${basename(model)} glosario ×${boost}`,
      model,
      words: { terms, boost },
    })),
    ...others.map((m) => ({ label: `${basename(m)} glosario`, model: m, words: { terms } })),
  ];
  const audio = ids.filter((id) => refs.has(id));
  console.log(`${audio.length} dictados, ${terms.length} términos\n`);
  for (const run of runs) {
    const engine = new VoiceEngine(run.model, { idleMs: 60_000, words: run.words });
    let errors = 0;
    let total = 0;
    let said = 0;
    let hit = 0;
    let invented = 0;
    let ms = 0;
    let seconds = 0;
    try {
      for (const id of audio) {
        const pcm = readFileSync(join(dir, `${id}.wav`)).subarray(44);
        const out = await engine.transcribe(pcm.toString("base64"));
        const ref = refs.get(id) ?? "";
        const hyp = fix(out.text);
        const w = wordErrors(ref, hyp);
        const t = termScore(ref, hyp, terms);
        errors += w.errors;
        total += w.words;
        said += t.said;
        hit += t.hit;
        invented += t.invented;
        ms += out.ms;
        seconds += pcm.length / 2 / VOICE_SAMPLE_RATE;
      }
      const wer = ((100 * errors) / Math.max(1, total)).toFixed(1);
      console.log(
        `${run.label}: WER ${wer} %, términos ${hit}/${said}, inventados ${invented}, ${Math.round(ms / Math.max(1, seconds))} ms/s`,
      );
    } catch (err) {
      console.log(`${run.label}: falló (${err instanceof Error ? err.message : String(err)})`);
    } finally {
      engine.stop();
    }
  }
}

if (import.meta.main) await main();
