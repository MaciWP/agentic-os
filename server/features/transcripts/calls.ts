import { z } from "zod";

// A call is the meeting app holding the microphone: Teams 2 runs input in
// com.microsoft.teams2.modulehost from the moment the user joins until they hang up (seen on a
// real call, 2026-10-22). The helper's `probe` reads that without any grant, so the server asks
// it on every tick instead of keeping a watcher process alive.
export const ProbeData = z.object({
  processes: z.array(z.object({ bundleId: z.string(), isRunningInput: z.boolean() })),
});

export const inCallOf = (data: unknown, prefix: string) =>
  ProbeData.parse(data).processes.some((p) => p.bundleId.startsWith(prefix) && p.isRunningInput);

export type CallPorts = {
  inCall: () => Promise<boolean>;
  // The recording running now, if any.
  running: () => { id: string; createdAt: string } | null;
  // Whether a recording was made at or after this instant (ms).
  recordedSince: (at: number) => boolean;
  start: () => Promise<void>;
  stop: (id: string) => void;
  // Each change of the call state, for the server log.
  log?: (line: string) => void;
};

// Recording starts once a call has lasted `startMs`, so a device test or a ring does not record,
// and stops once the call let the microphone go for `stopMs`, so a short drop does not split it.
// Only a recording begun before that release stops: one started by hand outside a call stays. A
// call that already has a recording, stopped by hand, is not recorded again.
// Two meetings back to back leave the microphone free for well under a minute (28 s and 35 s
// between two Teams calls, 2026-10-23), so a short wait is what splits them. A network drop
// longer than it splits one meeting in two, which the user accepted.
export const CALL_TIMING = { startMs: 5_000, stopMs: 10_000 };

export class CallWatcher {
  private since: number | null = null;
  private released: number | null = null;
  private last = false;

  constructor(
    private readonly ports: CallPorts,
    private readonly timing: { startMs: number; stopMs: number },
  ) {}

  async tick(now: number) {
    const inCall = await this.ports.inCall();
    if (inCall !== this.last)
      this.ports.log?.(inCall ? "call: microphone taken" : "call: microphone released");
    this.last = inCall;
    if (inCall) {
      this.released = null;
      this.since ??= now;
      if (
        now - this.since >= this.timing.startMs &&
        !this.ports.running() &&
        !this.ports.recordedSince(this.since)
      )
        await this.ports.start();
      return;
    }
    if (this.since === null) return;
    this.released ??= now;
    if (now - this.released < this.timing.stopMs) return;
    const rec = this.ports.running();
    if (rec && Date.parse(rec.createdAt) < this.released) this.ports.stop(rec.id);
    this.since = null;
    this.released = null;
  }
}
