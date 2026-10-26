import { type Cached, cached } from "../../cache.ts";
import { ProviderError } from "../../provider-error.ts";

// The Jira title and status of the keys Consumo lists: most are not among the user's open
// tickets (closed, or someone else's), so each is asked for alone and kept a while, since a
// ticket's title rarely changes and the page polls every minute.

export type JiraBrief = { title: string; status: { name: string; category: string } };

export const BRIEF_TTL_MS = 10 * 60_000;
// Keys asked to Jira at the same time.
const AT_ONCE = 4;

// null: Jira does not know the key (404), and that is kept too. Any other failure is thrown,
// so the page says Jira failed instead of reading it as an unknown key; nothing failed is kept.
export function briefLoader(
  get: (key: string) => Promise<JiraBrief>,
  now: () => number = Date.now,
) {
  const kept = new Map<string, Cached<JiraBrief | null>>();
  const brief = (key: string) => {
    let c = kept.get(key);
    if (!c) {
      const unknownIsNull = () =>
        get(key).catch((err) => {
          if (err instanceof ProviderError && err.status === 404) return null;
          throw err;
        });
      c = cached(unknownIsNull, { ttlMs: BRIEF_TTL_MS, now });
      kept.set(key, c);
    }
    return c.get();
  };
  return async (keys: string[]): Promise<Record<string, JiraBrief | null>> => {
    const out: Record<string, JiraBrief | null> = {};
    const all = [...new Set(keys)];
    for (let i = 0; i < all.length; i += AT_ONCE)
      await Promise.all(
        all.slice(i, i + AT_ONCE).map(async (key) => {
          out[key] = await brief(key);
        }),
      );
    return out;
  };
}
