import { type Config, LONG_PROMPT } from "../../config.ts";

export type Price = Omit<Config["pricing"][string], "over100k">;

// The price of a model: its own id, or the longest configured prefix of it; for a call whose
// prompt is over LONG_PROMPT, its long-prompt rates when it has them.
export function priceOf(pricing: Config["pricing"], model: string, long = false): Price | null {
  let best: string | null = null;
  for (const key of Object.keys(pricing))
    if (model.startsWith(key) && (best === null || key.length > best.length)) best = key;
  const price = best === null ? null : (pricing[best] ?? null);
  return long && price?.over100k ? price.over100k : price;
}

// The SQL that tells a call over LONG_PROMPT apart, so rows priced apart are grouped apart.
export const LONG = `(input + cache_read + cache_write + cache_write_1h) > ${LONG_PROMPT}`;

export type Counts = {
  input: number;
  cache_read: number;
  cache_write: number;
  cache_write_1h: number;
  output: number;
};

// Dollars for one model's tokens; prices are per million tokens.
export function costOf(price: Price, t: Counts): number {
  return (
    (t.input * price.input +
      t.cache_read * price.cacheRead +
      t.cache_write * price.cacheWrite +
      t.cache_write_1h * (price.cacheWrite1h ?? price.cacheWrite) +
      t.output * price.output) /
    1e6
  );
}
