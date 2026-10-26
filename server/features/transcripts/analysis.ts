import { join } from "node:path";
import { z } from "zod";
import { log } from "../../log.ts";
import { run } from "../../run.ts";
import { Range, Turn } from "./contracts.ts";
import type { DiarizeJob, VadJob } from "./worker.ts";

const logger = log("transcripts");
const WORKER = join(import.meta.dir, "worker.ts");
// Below the agents' own work: the user's Claude sessions come first.
const NICE = "10";

// Diarizing a long meeting takes minutes: the cap is a hang guard, not a budget.
const TIMEOUT_MS = 2 * 60 * 60_000;

async function exec<S extends z.ZodType>(
  op: "vad" | "diarize",
  job: unknown,
  schema: S,
): Promise<z.infer<S>> {
  const out = await run(["nice", "-n", NICE, process.execPath, WORKER, op, JSON.stringify(job)], {
    timeoutMs: TIMEOUT_MS,
    maxBytes: 16 * 1024 * 1024,
  });
  if (out.code !== 0) {
    logger.error(`${op} worker failed`, { stderr: out.stderr.trim().slice(-300) });
    const why = out.timedOut
      ? "timed out"
      : out.truncated
        ? "output too large"
        : `exit ${out.code}`;
    throw new Error(`${op} failed (${why})`);
  }
  return schema.parse(JSON.parse(out.stdout));
}

export const detectSpeech = (job: z.infer<typeof VadJob>) => exec("vad", job, z.array(Range));
export const diarizeTrack = (job: z.infer<typeof DiarizeJob>) =>
  exec("diarize", job, z.array(Turn));
