import { useSyncExternalStore } from "react";

// The one shape for state a module keeps outside React: a value, its listeners and a hook.
// A module holds its state in a `createStore`, never in a loose `let` (scripts/layers.test.ts checks).
export type Store<T> = {
  get(): T;
  // Listeners run only when the value changes (Object.is).
  set(value: T): void;
  update(change: (current: T) => T): void;
  subscribe(listener: () => void): () => void;
};

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  const set = (next: T) => {
    if (Object.is(next, value)) return;
    value = next;
    for (const listener of listeners) listener();
  };
  return {
    get: () => value,
    set,
    update: (change) => set(change(value)),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// Server rendering (and the tests that render to a string) reads the current value too.
export const useStore = <T>(store: Store<T>): T =>
  useSyncExternalStore(store.subscribe, store.get, store.get);
