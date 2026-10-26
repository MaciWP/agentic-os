import type { z } from "zod";

// The only door to `localStorage` and `sessionStorage`. Each key is declared once, next to the
// code that owns it, with its zod schema and its default; every name starts with `aos.`
// (scripts/layers.test.ts checks both). Reads never throw: a private window, a blocked or
// full storage, bad JSON or a value the schema refuses all give the default. Writes say whether
// the value was kept, for the views that tell the user when it was not.

export type StorageArea = "local" | "session";
type Name = `aos.${string}`;

type Options<T> = {
  schema: z.ZodType<T>;
  fallback: NoInfer<T>;
  // Default local. Session values live and die with the tab.
  area?: StorageArea;
  // "text" (default) keeps the string as is, so values written before this module stay
  // readable; "json" for objects and lists.
  codec?: "text" | "json";
};

export type StoredValue<T> = {
  get(): T;
  set(value: T): boolean;
  remove(): boolean;
  // Calls `on` with the new value each time another tab of this browser writes the key (a local
  // one: session values never cross tabs). Returns the unsubscribe.
  watch(on: (value: T) => void): () => void;
};

export type StoredFamily<T> = {
  get(id: string): T;
  set(id: string, value: T): boolean;
  remove(id: string): boolean;
  // The ids kept now, in no particular order.
  ids(): string[];
};

// An area set here is served by this Storage instead of the browser's (none: unavailable).
// Only tests set it, through web/test-storage.ts.
export const swapped = new Map<StorageArea, Storage | undefined>();

// The Storage behind an area, looked up on every call: tests and browsers may change it.
export function storageBackend(area: StorageArea): Storage | undefined {
  if (swapped.has(area)) return swapped.get(area);
  try {
    return area === "local" ? globalThis.localStorage : globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

// Reads `name`; when it is missing and `legacy` is set, the value under the old unprefixed name
// moves to `name` once, so no setting is lost to the rename.
function readRaw(area: StorageArea, name: string, legacy?: string): string | null {
  const disk = storageBackend(area);
  try {
    const value = disk?.getItem(name) ?? null;
    if (value !== null || !legacy || !disk) return value;
    const old = disk.getItem(legacy);
    if (old === null) return null;
    try {
      disk.setItem(name, old);
      disk.removeItem(legacy);
    } catch {}
    return old;
  } catch {
    return null;
  }
}

function decode<T>(raw: string | null, o: Options<T>): T {
  if (raw === null) return o.fallback;
  try {
    const parsed = o.schema.safeParse(o.codec === "json" ? JSON.parse(raw) : raw);
    return parsed.success ? parsed.data : o.fallback;
  } catch {
    return o.fallback;
  }
}

function write(area: StorageArea, name: string, raw: string | null, legacy?: string): boolean {
  const disk = storageBackend(area);
  if (!disk) return false;
  try {
    if (raw === null) disk.removeItem(name);
    else disk.setItem(name, raw);
    if (legacy) disk.removeItem(legacy);
    return true;
  } catch {
    return false;
  }
}

// The machine this tab works on (web/machine.ts). A worker's tab keeps its own copy of every
// other key, so one machine's Mesas, open nodes and notes never reach the other's.
const MACHINE = "aos.machine";
function scoped(name: string): string {
  if (name === MACHINE) return name;
  let machine: string | null = null;
  try {
    machine = storageBackend("session")?.getItem(MACHINE) ?? null;
  } catch {}
  return machine ? `aos.@${machine}.${name.slice("aos.".length)}` : name;
}

const encode = <T>(value: T, o: Options<T>) =>
  o.codec === "json" ? JSON.stringify(value) : String(value);

export function storageKey<T>(name: Name, o: Options<T> & { legacy?: string }): StoredValue<T> {
  const area = o.area ?? "local";
  return {
    get: () => decode(readRaw(area, scoped(name), o.legacy), o),
    set: (value) => write(area, scoped(name), encode(value, o), o.legacy),
    remove: () => write(area, scoped(name), null, o.legacy),
    watch(on) {
      if (typeof window === "undefined") return () => {};
      const listen = (e: StorageEvent) => {
        if (e.key === scoped(name)) on(decode(e.newValue, o));
      };
      window.addEventListener("storage", listen);
      return () => window.removeEventListener("storage", listen);
    },
  };
}

// Keys that share a prefix and differ by an id: `${prefix}${id}`.
export function storageFamily<T>(
  prefix: Name,
  o: Options<T> & { legacy?: (id: string) => string },
): StoredFamily<T> {
  const area = o.area ?? "local";
  return {
    get: (id) => decode(readRaw(area, scoped(prefix) + id, o.legacy?.(id)), o),
    set: (id, value) => write(area, scoped(prefix) + id, encode(value, o), o.legacy?.(id)),
    remove: (id) => write(area, scoped(prefix) + id, null, o.legacy?.(id)),
    ids() {
      const disk = storageBackend(area);
      const at = scoped(prefix);
      const ids: string[] = [];
      try {
        for (let i = 0; disk && i < disk.length; i++) {
          const key = disk.key(i);
          if (key?.startsWith(at)) ids.push(key.slice(at.length));
        }
      } catch {}
      return ids;
    },
  };
}
