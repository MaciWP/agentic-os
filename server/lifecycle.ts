import { log } from "./log.ts";

export class Lifecycle {
  private readonly starters: (() => undefined | (() => void))[] = [];
  private stops: (() => void)[] = [];
  private started = false;
  private disposed = false;

  add(start: () => undefined | (() => void)) {
    if (this.started || this.disposed) throw new Error("lifecycle already started or disposed");
    this.starters.push(start);
  }
  start() {
    if (this.started) return;
    if (this.disposed) throw new Error("lifecycle disposed");
    this.started = true;
    try {
      for (const start of this.starters) {
        const stop = start();
        if (stop) this.stops.push(stop);
      }
    } catch (err) {
      this.dispose();
      throw err;
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const stop of this.stops.reverse()) {
      try {
        stop();
      } catch (err) {
        log("server").error("resource cleanup failed", { err });
      }
    }
    this.stops = [];
  }
}
