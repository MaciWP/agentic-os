// Keeps the Mac awake while at least one terminal runs, so agents go on working with the
// screen off or the lid closed on an external display. `caffeinate -i -s` blocks idle sleep,
// and system sleep while on AC power; `-w` ends it with this server, so a crash never leaves
// the Mac awake for nothing. On battery with the lid closed macOS sleeps anyway.
//
// The screen is a second hold, only on request: `-d` keeps the display on, so the screensaver
// (and the lock a managed Mac puts after it) never starts. The user switches it on for a time,
// or the config keeps it while an agent works. Locking by hand (Ctrl+Cmd+Q) still works.

import { errorMessage } from "../../error-message.ts";
import { log } from "../../log.ts";
import type { Terminals } from "../terminals/contract.ts";

// Remote availability: AC sleep only. The supervisor holds it itself (`scripts/supervise.ts`),
// so a server restart leaves no gap for a closed lid to sleep in, and tells the server so with
// AWAKE_ENV; a server started without it holds its own.
export const AWAKE_ENV = "AOS_SUPERVISOR_AWAKE";
export const remoteHold = (pid: number) => ["/usr/bin/caffeinate", "-s", "-w", String(pid)];

export type Holder = { kill(): void };
export type Spawn = (argv: string[]) => Holder;

// `until` null: until switched off, or, with `auto`, while an agent works.
export type ScreenState = { until: string | null; auto: boolean };
export type AwakeState = {
  held: boolean;
  since: string | null;
  screen: ScreenState | null;
  remote?: boolean;
};
// Runs `fn` after `ms`; returns the cancel.
export type Timer = (fn: () => void, ms: number) => () => void;

const bunSpawn: Spawn = (argv) =>
  Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
const unrefTimer: Timer = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
};

export class KeepAwake {
  private holder: Holder | null = null;
  private remoteHolder: Holder | null = null;
  private since: string | null = null;
  private screen: Holder | null = null;
  private manual: { until: string | null; cancel: () => void } | null = null;
  private agentsWorking = false;
  private remoteOn = false;

  private readonly spawn: Spawn;
  private readonly pid: number;
  private readonly now: () => Date;
  // Keep the screen on while any agent works, without asking.
  private readonly screenWhileAgentsWork: boolean;
  private readonly timer: Timer;
  // The supervisor holds remote availability for this server.
  private readonly remoteHeld: boolean;

  constructor(
    opts: {
      spawn?: Spawn;
      pid?: number;
      now?: () => Date;
      screenWhileAgentsWork?: boolean;
      timer?: Timer;
      remoteHeld?: boolean;
    } = {},
  ) {
    this.spawn = opts.spawn ?? bunSpawn;
    this.pid = opts.pid ?? process.pid;
    this.now = opts.now ?? (() => new Date());
    this.screenWhileAgentsWork = opts.screenWhileAgentsWork ?? false;
    this.timer = opts.timer ?? unrefTimer;
    this.remoteHeld = opts.remoteHeld ?? false;
  }

  // The screen stays on for `minutes`, or until released when null. A new hold replaces the
  // last one.
  hold(minutes: number | null): void {
    this.manual?.cancel();
    const cancel =
      minutes === null
        ? () => {}
        : this.timer(() => {
            this.manual = null;
            this.syncScreen();
          }, minutes * 60_000);
    const until =
      minutes === null ? null : new Date(this.now().getTime() + minutes * 60_000).toISOString();
    this.manual = { until, cancel };
    this.syncScreen();
  }

  release(): void {
    this.manual?.cancel();
    this.manual = null;
    this.syncScreen();
  }

  private syncScreen(): void {
    const want = this.manual !== null || (this.screenWhileAgentsWork && this.agentsWorking);
    if (want && !this.screen)
      this.screen = this.spawn(["/usr/bin/caffeinate", "-d", "-i", "-s", "-w", String(this.pid)]);
    else if (!want && this.screen) {
      this.screen.kill();
      this.screen = null;
    }
  }

  sync(anyRunning: boolean, agentsWorking = false): void {
    this.agentsWorking = agentsWorking;
    this.syncScreen();
    if (anyRunning && !this.holder) {
      this.holder = this.spawn(["/usr/bin/caffeinate", "-i", "-s", "-w", String(this.pid)]);
      this.since = this.now().toISOString();
    } else if (!anyRunning && this.holder) {
      this.holder.kill();
      this.holder = null;
      this.since = null;
    }
  }

  // Syncs now and on every change of the terminals list, one list read at a time: a burst
  // of changes ends in one more read. A failed read keeps the current state. Returns the stop.
  follow(terminals: Terminals): () => void {
    let stopped = false;
    let reading = false;
    let again = false;
    const check = () => {
      if (stopped) return;
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      Promise.resolve(terminals.list())
        .then(
          (list) =>
            !stopped &&
            this.sync(
              list.some((t) => t.state === "running"),
              list.some((t) => t.state === "running" && t.agent?.state === "working"),
            ),
        )
        .catch((err) => log("keep awake").error(errorMessage(err)))
        .finally(() => {
          reading = false;
          if (again) {
            again = false;
            check();
          }
        });
    };
    const stop = terminals.subscribe(check);
    check();
    return () => {
      stopped = true;
      stop();
    };
  }

  state(): AwakeState {
    const screen = this.manual
      ? { until: this.manual.until, auto: false }
      : this.screen
        ? { until: null, auto: true }
        : null;
    const remote = this.remoteHolder !== null || (this.remoteHeld && this.remoteOn);
    return {
      held: this.holder !== null || remote,
      since: this.since,
      screen,
      ...(remote && { remote: true }),
    };
  }

  remote(enabled: boolean): void {
    this.remoteOn = enabled;
    if (enabled && !this.remoteHolder && !this.remoteHeld)
      this.remoteHolder = this.spawn(remoteHold(this.pid));
    if (!enabled) {
      this.remoteHolder?.kill();
      this.remoteHolder = null;
    }
  }
  dispose(): void {
    this.remote(false);
    this.manual?.cancel();
    this.manual = null;
    this.holder?.kill();
    this.screen?.kill();
    this.holder = null;
    this.screen = null;
  }
}
