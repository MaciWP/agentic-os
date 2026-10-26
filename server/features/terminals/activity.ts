import type { TerminalKind } from "./contract.ts";

// Whether a terminal is working, judged from its output. Bytes are summed per second over
// the last WINDOW_MS: above the kind's threshold it is busy, otherwise idle. A state holds
// at least DWELL_MS, so bursty output does not flip it every second. A silent terminal costs
// nothing: the ticker starts with counted output and stops once the window is empty again.

export type ActivityState = "busy" | "idle";

export const TICK_MS = 1000;
export const WINDOW_MS = 5000;
export const DWELL_MS = 5000;
// A redraw the app caused (a window attached or resized, keys typed) is not the program
// working, so output this soon after one is not counted.
export const MUTE_MS = 1000;

// Bytes per window a quiet program still prints. Probed on 2026-10-02 at the prompt, no
// message sent: a shell prints nothing; claude 43–78 bytes in a window from its status line
// (it redraws every 10 s); codex was only seen at its update dialog (0 bytes), so its value
// is unverified. grok redraws 27–51 KB per window while it waits, so its output says nothing
// and it has no activity (null).
export const IDLE_BYTES: Record<TerminalKind, number | null> = {
  shell: 0,
  env: 0,
  claude: 1024,
  codex: 1024,
  grok: null,
};

export type Clock = { now(): number; every(ms: number, run: () => void): () => void };

export const realClock: Clock = {
  now: Date.now,
  every(ms, run) {
    const timer = setInterval(run, ms);
    timer.unref();
    return () => clearInterval(timer);
  },
};

export class Activity {
  state: ActivityState = "idle";
  // The last output that counted, in ms.
  lastOutputAt: number | null = null;
  // The first flip is never held back: a program that starts printing is busy at once.
  private since = Number.NEGATIVE_INFINITY;
  private mutedUntil = Number.NEGATIVE_INFINITY;
  private current = 0;
  private window: number[] = [];
  private stopTicker: (() => void) | undefined;

  constructor(
    private readonly threshold: number | null,
    // Called on a flip only, never per output.
    private readonly onFlip: () => void,
    private readonly clock: Clock = realClock,
  ) {}

  // Whether this terminal's output can tell busy from idle at all.
  get tracked(): boolean {
    return this.threshold !== null;
  }

  output(bytes: number): void {
    if (this.threshold === null || bytes === 0) return;
    const now = this.clock.now();
    if (now < this.mutedUntil) return;
    this.lastOutputAt = now;
    this.current += bytes;
    this.stopTicker ??= this.clock.every(TICK_MS, () => this.tick());
  }

  mute(): void {
    this.mutedUntil = this.clock.now() + MUTE_MS;
  }

  // The program ended: no ticker outlives it, and an ended terminal is not working.
  end(): void {
    this.stop();
    this.state = "idle";
  }

  private tick(): void {
    this.window.push(this.current);
    this.current = 0;
    if (this.window.length > WINDOW_MS / TICK_MS) this.window.shift();
    const sum = this.window.reduce((a, b) => a + b, 0);
    const want: ActivityState = sum > (this.threshold ?? 0) ? "busy" : "idle";
    const now = this.clock.now();
    if (want !== this.state && now - this.since >= DWELL_MS) {
      this.state = want;
      this.since = now;
      this.onFlip();
    }
    if (this.state === "idle" && sum === 0) this.stop();
  }

  private stop(): void {
    this.stopTicker?.();
    this.stopTicker = undefined;
    this.window = [];
    this.current = 0;
  }
}
