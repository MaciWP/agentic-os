// When the code editor saves, with no button: a moment after the last key, on leaving the
// editor, on switching file and on ⌘S. One save at a time; keys typed meanwhile go in the
// next. A save only lands on the version the editor opened: when the disk changed under
// unsaved text (an agent wrote the file), saving stops until the user picks one side.

export type SaveStatus = "saved" | "dirty" | "saving" | "conflict" | "failed";

// What a poll's version means for the editor: nothing new, take the disk's text (nothing is
// unsaved), a conflict, or wait (a save is on its way and may be what changed it).
export type DiskVerdict = "same" | "take" | "conflict" | "wait";

export type Saver = {
  save: (text: string, base: string) => Promise<{ version: string }>;
  // The editor's text now, and its revision: the same revision is the same text, undo back
  // to it included.
  text: () => string;
  rev: () => number;
  // A refusal because the disk changed (409 stale).
  isStale: (err: unknown) => boolean;
  onStatus: (status: SaveStatus, error: unknown) => void;
  delayMs?: number;
  timer?: { set: (run: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
};

export const SAVE_DELAY_MS = 800;
const TIMER = {
  set: (run: () => void, ms: number) => setTimeout(run, ms),
  clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class Autosave {
  status: SaveStatus = "saved";
  private flight: Promise<void> | null = null;
  private waiting: unknown = null;
  private readonly timer: NonNullable<Saver["timer"]>;

  // `base` is the version on disk the text started from; `savedRev` the revision that holds
  // it (another revision, a draft brought back, is unsaved from the start).
  constructor(
    private readonly s: Saver,
    public base: string,
    private savedRev: number,
  ) {
    this.timer = s.timer ?? TIMER;
  }

  get dirty() {
    return this.s.rev() !== this.savedRev;
  }

  // After each change the user makes.
  edited() {
    if (this.status === "conflict") return;
    this.cancel();
    if (this.flight) return;
    if (!this.dirty) return this.set("saved");
    this.set("dirty");
    this.waiting = this.timer.set(() => void this.flush(), this.s.delayMs ?? SAVE_DELAY_MS);
  }

  // Save now what is unsaved; the promise settles when nothing more is on its way.
  flush(): Promise<void> {
    this.cancel();
    if (this.flight) return this.flight;
    if (this.status === "conflict" || !this.dirty) return Promise.resolve();
    const rev = this.s.rev();
    const text = this.s.text();
    this.set("saving");
    this.flight = this.s
      .save(text, this.base)
      .then(
        ({ version }) => {
          this.base = version;
          this.savedRev = rev;
          this.set(this.dirty ? "dirty" : "saved");
        },
        (err: unknown) => this.set(this.s.isStale(err) ? "conflict" : "failed", err),
      )
      .finally(() => {
        this.flight = null;
      })
      // Keys typed during the save: the next one, at once.
      .then(() => (this.status === "dirty" ? this.flush() : undefined));
    return this.flight;
  }

  // A poll brought the disk's `version`.
  disk(version: string): DiskVerdict {
    if (version === this.base) return "same";
    if (this.flight) return "wait";
    if (this.status !== "conflict" && !this.dirty) return "take";
    this.cancel();
    this.set("conflict");
    return "conflict";
  }

  // The editor now holds the disk's text at `version` (a clean poll, or "use the disk's").
  took(version: string) {
    this.cancel();
    this.base = version;
    this.savedRev = this.s.rev();
    this.set("saved");
  }

  // "Save mine over it": the text goes over the disk's `version`, still checked against it.
  overwrite(version: string): Promise<void> {
    this.base = version;
    this.set("dirty");
    return this.flush();
  }

  private cancel() {
    if (this.waiting !== null) this.timer.clear(this.waiting);
    this.waiting = null;
  }

  private set(status: SaveStatus, error: unknown = null) {
    this.status = status;
    this.s.onStatus(status, error);
  }
}

// The smallest replacement that turns `from` into `to`: what they share at both ends stays,
// so the editor's cursor, folds and undo keep their place when an agent's edit comes in.
export function minimalEdit(from: string, to: string) {
  const most = Math.min(from.length, to.length);
  let start = 0;
  while (start < most && from[start] === to[start]) start++;
  let end = 0;
  while (end < most - start && from[from.length - 1 - end] === to[to.length - 1 - end]) end++;
  return { start, end: from.length - end, text: to.slice(start, to.length - end) };
}
