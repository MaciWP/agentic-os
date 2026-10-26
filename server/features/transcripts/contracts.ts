import { z } from "zod";

export const SAMPLE_RATE = 16_000;
export const SPEAKER_ME = "me";
// Everyone on the system track before the diarization tells them apart.
export const SPEAKER_OTHERS = "others";

// What the capture helper writes in <dir>/state.json. Not strict: the helper may add fields.
export const HelperState = z.object({
  status: z.enum(["recording", "stopped", "failed"]),
  pid: z.number().int().nullish(),
  error: z.string().nullish(),
  // Codes such as mic_silent or system_silent, while the recording goes on.
  warnings: z.array(z.string()).nullish(),
});
export type HelperState = z.infer<typeof HelperState>;

export const Range = z.object({ start: z.number().min(0), end: z.number().min(0) });
export type Range = z.infer<typeof Range>;

export const Words = Range.extend({ text: z.string() });
export type Words = z.infer<typeof Words>;

// A stretch of the system track one speaker (0, 1, ...) talks.
export const Turn = Range.extend({ speaker: z.number().int().min(0) });
export type Turn = z.infer<typeof Turn>;

export const Segment = Words.extend({ speaker: z.string() });
export type Segment = z.infer<typeof Segment>;

export const StartBody = z.strictObject({
  meetingId: z.number().int().positive().optional(),
  speakers: z.number().int().min(1).max(20).optional(),
});
export const NamesBody = z.strictObject({
  names: z.record(z.string().min(1).max(60), z.string().max(60)),
});

export const DecideBody = z.strictObject({
  state: z.enum(["accepted", "discarded"]),
  text: z.string().trim().min(1).max(400).optional(),
});

export const Track = z.enum(["mic", "system"]);
export type Track = z.infer<typeof Track>;
export type Status = "recording" | "transcribing" | "diarizing" | "ready" | "failed";
