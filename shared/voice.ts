// A dictation travels as 16-bit little-endian mono PCM at this rate: what the model takes, so
// neither end resamples or decodes a container.
export const VOICE_SAMPLE_RATE = 16_000;
export const MAX_DICTATION_SECONDS = 120;
export const MAX_DICTATION_BYTES = VOICE_SAMPLE_RATE * 2 * MAX_DICTATION_SECONDS;
