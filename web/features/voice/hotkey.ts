// Hold ⌃⌘ to dictate: the microphone opens as both keys go down, so the first word is not lost
// while it starts. Released before HOLD_MS, or with another key in between, it was a tap or a
// shortcut: the recording is dropped and the key goes through, so ⌃⌘ shortcuts keep working.
// After HOLD_MS, releasing either key stops and Esc cancels.
// While a dictation runs (the hold, or one started with the button), Esc is the dictation's:
// an Esc that reached Claude would interrupt its turn.

export const HOLD_MS = 200;

export type DictationAction = "start" | "stop" | "cancel";
export type KeyEventLike = {
  type: string;
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
};
// Runs `fn` after `ms`; returns the cancel.
type Timer = (fn: () => void, ms: number) => () => void;

const browserTimer: Timer = (fn, ms) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};
const isModifier = (key: string) => key === "Control" || key === "Meta";

export class DictationKeys {
  private phase: "idle" | "arming" | "recording" = "idle";
  private cancelHold: (() => void) | null = null;

  constructor(
    private readonly on: (action: DictationAction) => void,
    // `enabled`: this terminal takes dictation now. `busy`: a dictation records or awaits its
    // text, however it started.
    private readonly state: { enabled: () => boolean; busy: () => boolean },
    private readonly timer: Timer = browserTimer,
  ) {}

  // False: the key belongs to the dictation and the terminal must not see it.
  handle(e: KeyEventLike): boolean {
    if (this.phase === "recording") return this.whileRecording(e);
    if (this.phase === "arming") {
      if (e.key === "Escape") {
        if (e.type === "keydown") this.disarm();
        return false;
      }
      if (e.type === "keydown" && !isModifier(e.key)) this.disarm();
      else if (e.type === "keyup" && isModifier(e.key)) this.disarm();
      return true;
    }
    if (this.state.busy()) {
      if (e.type === "keydown" && e.key === "Escape") this.on("cancel");
      return e.key !== "Escape";
    }
    if (
      e.type === "keydown" &&
      !e.repeat &&
      isModifier(e.key) &&
      e.ctrlKey &&
      e.metaKey &&
      !e.altKey &&
      !e.shiftKey &&
      this.state.enabled()
    ) {
      this.phase = "arming";
      this.on("start");
      this.cancelHold = this.timer(() => {
        this.cancelHold = null;
        this.phase = "recording";
      }, HOLD_MS);
    }
    return true;
  }

  // The window lost the keys: a hold never ends with a keyup it will not see.
  blur(): void {
    if (this.phase === "arming") this.disarm();
    else if (this.phase === "recording") {
      this.phase = "idle";
      this.on("cancel");
    }
  }

  private whileRecording(e: KeyEventLike): boolean {
    if (e.type === "keydown" && e.key === "Escape") {
      this.phase = "idle";
      this.on("cancel");
    } else if (e.type === "keyup" && isModifier(e.key)) {
      this.phase = "idle";
      this.on("stop");
    }
    return false;
  }

  private disarm(): void {
    this.cancelHold?.();
    this.cancelHold = null;
    this.phase = "idle";
    this.on("cancel");
  }
}
