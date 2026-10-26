// Dictations already released and on their way to text, one per terminal. They live here and
// not in the terminal's view: a view left mid-transcription (another Mesa, Agentes, Consumo)
// is gone when the text comes back, so the text goes to the terminal through the server, and a
// view of that terminal opened meanwhile shows the wait and can still drop it with Esc.

// `run` is set while a transcription is on its way. `error` is the last failure no view has
// shown yet.
export type PendingSlot = { run: number | null; error: string | null };
export type PendingOutcome =
  | { outcome: "done"; text: string }
  | { outcome: "failed"; message: string }
  | { outcome: "cancelled" };

type Deps = {
  transcribe: (pcm: Int16Array) => Promise<string>;
  // Where the text goes: pasted at the terminal's prompt, never followed by Enter, or added to
  // the phone's composer draft.
  send: (terminal: string, text: string) => Promise<unknown>;
  message: (err: unknown) => string;
};

const IDLE: PendingSlot = { run: null, error: null };

export function createPendingStore(deps: Deps) {
  const slots = new Map<string, PendingSlot>();
  const listeners = new Set<() => void>();
  let runs = 0;
  const get = (terminal: string) => slots.get(terminal) ?? IDLE;
  const set = (terminal: string, slot: PendingSlot) => {
    if (slot.run === null && slot.error === null) slots.delete(terminal);
    else slots.set(terminal, slot);
    for (const listener of listeners) listener();
  };

  return {
    get,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    // Text that comes back after a cancel, or after a newer dictation, goes nowhere.
    async transcribe(terminal: string, pcm: Int16Array): Promise<PendingOutcome> {
      const run = ++runs;
      set(terminal, { run, error: null });
      const current = () => get(terminal).run === run;
      try {
        const text = (await deps.transcribe(pcm)).trim();
        if (!current()) return { outcome: "cancelled" };
        if (text) await deps.send(terminal, `${text} `);
        if (current()) set(terminal, IDLE);
        return { outcome: "done", text };
      } catch (err) {
        if (!current()) return { outcome: "cancelled" };
        const message = deps.message(err);
        set(terminal, { run: null, error: message });
        return { outcome: "failed", message };
      }
    },
    cancel(terminal: string) {
      if (get(terminal).run !== null) set(terminal, IDLE);
    },
    // The failure once, to the first view that shows it.
    takeError(terminal: string): string | null {
      const { run, error } = get(terminal);
      if (error !== null) set(terminal, { run, error: null });
      return error;
    },
  };
}

export type PendingStore = ReturnType<typeof createPendingStore>;
