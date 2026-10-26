import { type StorageArea, swapped } from "./storage.ts";

// Test seam: puts an in-memory Storage behind `area` (none: storage unavailable, as in a
// blocked browser) until `restore`. `data` is what it holds.
export function memoryStorage(area: StorageArea, entries: Record<string, string> | null = {}) {
  const had = swapped.has(area);
  const before = swapped.get(area);
  const data = new Map(Object.entries(entries ?? {}));
  const disk: Storage = {
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
    clear: () => data.clear(),
  };
  swapped.set(area, entries === null ? undefined : disk);
  return {
    data,
    restore() {
      if (had) swapped.set(area, before);
      else swapped.delete(area);
    },
  };
}
