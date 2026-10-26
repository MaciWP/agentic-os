import type { Turn } from "./contracts.ts";

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
  return s;
};
export const cosine = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  dot(a, b) / (Math.sqrt(dot(a, a) * dot(b, b)) || 1);

// Speakers found block by block, each block numbering its own from 0, become one set: a block's
// speaker joins the known speaker its voice is closest to (cosine of the embeddings, at least
// `threshold`), never two of one block to the same one; otherwise it is new.
export class SpeakerLinker {
  private readonly sums: Float64Array[] = [];

  constructor(private readonly threshold: number) {}

  get size() {
    return this.sums.length;
  }

  // `voices[i]`: the embedding of the block's speaker i. Returns each one's global id.
  link(voices: ArrayLike<number>[]): number[] {
    const pairs = voices
      .flatMap((v, local) => this.sums.map((s, global) => ({ local, global, sim: cosine(v, s) })))
      .filter((p) => p.sim >= this.threshold)
      .sort((a, b) => b.sim - a.sim);
    const ids: (number | undefined)[] = voices.map(() => undefined);
    const used = new Set<number>();
    for (const p of pairs) {
      if (ids[p.local] !== undefined || used.has(p.global)) continue;
      ids[p.local] = p.global;
      used.add(p.global);
    }
    return voices.map((v, local) => {
      let id = ids[local];
      if (id === undefined) {
        id = this.sums.length;
        this.sums.push(new Float64Array(v.length));
      }
      const sum = this.sums[id] as Float64Array;
      for (let i = 0; i < v.length; i++) sum[i] = (sum[i] as number) + (v[i] as number);
      return id;
    });
  }

  // The user said `count` people talk: the two closest speakers merge until that many remain.
  // Returns where each id went.
  mergeDown(count: number): number[] {
    const into = this.sums.map((_, i) => i);
    const alive = new Set(into);
    while (alive.size > count) {
      const ids = [...alive];
      let best: [number, number, number] = [-1, -1, Number.NEGATIVE_INFINITY];
      for (const a of ids)
        for (const b of ids) {
          const sim =
            a < b ? cosine(this.sums[a] as Float64Array, this.sums[b] as Float64Array) : -2;
          if (sim > best[2]) best = [a, b, sim];
        }
      const [keep, drop] = best;
      const sum = this.sums[keep] as Float64Array;
      this.sums[drop]?.forEach((x, i) => {
        sum[i] = (sum[i] as number) + x;
      });
      alive.delete(drop);
      for (let i = 0; i < into.length; i++) if (into[i] === drop) into[i] = keep;
    }
    return into;
  }
}

// The clustering leaves crumbs: dozens of "speakers" with a few seconds each in a block where a
// handful of people talk (204 labels for 7 people in a real 3 h call). A speaker with less than
// `minSeconds` of speech joins the closest voice among those with at least that much; with none
// that long, everyone stays. Returns where each speaker went (itself when it stays).
export function foldCrumbs(
  voices: ArrayLike<number>[],
  seconds: number[],
  minSeconds: number,
): number[] {
  const big = seconds.flatMap((s, i) => (s >= minSeconds ? [i] : []));
  return voices.map((v, i) => {
    if (big.length === 0 || big.includes(i)) return i;
    let best = big[0] as number;
    for (const j of big)
      if (cosine(v, voices[j] as ArrayLike<number>) > cosine(v, voices[best] as ArrayLike<number>))
        best = j;
    return best;
  });
}

// Speaker ids renumbered 0, 1, ... in the order they first talk, turns in time order.
export function relabel(turns: Turn[]): Turn[] {
  const sorted = [...turns].sort((a, b) => a.start - b.start);
  const order = new Map<number, number>();
  return sorted.map((t) => {
    if (!order.has(t.speaker)) order.set(t.speaker, order.size);
    return { ...t, speaker: order.get(t.speaker) as number };
  });
}
