import { z } from "zod";
import { getSecret, setSecret } from "./secrets.ts";

// Each worker's pairing token, by machine id, in one Keychain item. Only the hub reads them,
// to send its code to a worker (server/machines.ts) and to poll its outbox every few seconds.
// The item is read once and kept in memory: a periodic credential read is what the corporate
// EDR flags, and the outbox poll alone asked twice every 3 s. A missing item is read again on
// the next call, so a hub paired from elsewhere, or a read that failed, recovers on its own.
const Tokens = z.record(z.string(), z.string());
const NAME = "machines.tokens";

// The one Keychain item, read and written whole.
type Item = { get: () => Promise<string | null>; set: (value: string) => Promise<void> };

export function tokenStore(item: Item) {
  let kept: Promise<Record<string, string> | null> | undefined;
  const load = async () => {
    const raw = await item.get();
    if (!raw) return null;
    try {
      const parsed = Tokens.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  };
  const read = async () => {
    kept ??= load();
    try {
      const tokens = await kept;
      if (!tokens) kept = undefined;
      return tokens ?? {};
    } catch (err) {
      kept = undefined;
      throw err;
    }
  };
  return {
    get: async (id: string) => (await read())[id] ?? null,
    set: async (id: string, token: string) => {
      const next = { ...(await read()), [id]: token };
      await item.set(JSON.stringify(next));
      kept = Promise.resolve(next);
    },
  };
}

export const machineTokens = tokenStore({
  get: () => getSecret(NAME),
  set: (value) => setSecret(NAME, value),
});
