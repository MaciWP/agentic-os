// Durations as counts in fixed buckets, so any window's percentiles come from summing minutes:
// a p95 per minute cannot be added up into an hour's.
//
// Buckets grow by 2^(1/4) from 0.1 ms: a percentile is the middle of its bucket, within ±9 % of
// the true value, which shows a 20 % slowdown. Only buckets with counts are stored.

const MIN_MS = 0.1;
const RATIO = 2 ** 0.25;
// 20 minutes; anything slower shares the last bucket.
export const LAST = Math.ceil(Math.log(1_200_000 / MIN_MS) / Math.log(RATIO));

export type Histo = {
  n: number;
  errors: number;
  sum: number;
  max: number;
  buckets: Record<number, number>;
};

export const emptyHisto = (): Histo => ({ n: 0, errors: 0, sum: 0, max: 0, buckets: {} });

export const bucketOf = (ms: number) =>
  ms <= MIN_MS ? 0 : Math.min(LAST, Math.ceil(Math.log(ms / MIN_MS) / Math.log(RATIO)));

export function record(h: Histo, ms: number, error: boolean): void {
  const i = bucketOf(ms);
  h.buckets[i] = (h.buckets[i] ?? 0) + 1;
  h.n++;
  h.sum += ms;
  if (ms > h.max) h.max = ms;
  if (error) h.errors++;
}

export function merge(into: Histo, from: Histo): Histo {
  into.n += from.n;
  into.errors += from.errors;
  into.sum += from.sum;
  into.max = Math.max(into.max, from.max);
  for (const [i, c] of Object.entries(from.buckets))
    into.buckets[Number(i)] = (into.buckets[Number(i)] ?? 0) + c;
  return into;
}

// The geometric middle of the bucket where the share is reached, never above the slowest seen.
export function quantile(h: Histo, q: number): number {
  if (h.n === 0) return 0;
  const want = Math.ceil(q * h.n);
  let seen = 0;
  const filled = Object.keys(h.buckets)
    .map(Number)
    .sort((a, b) => a - b);
  for (const i of filled) {
    seen += h.buckets[i] ?? 0;
    if (seen >= want) return Math.min(i === 0 ? MIN_MS : MIN_MS * RATIO ** (i - 0.5), h.max);
  }
  return h.max;
}
