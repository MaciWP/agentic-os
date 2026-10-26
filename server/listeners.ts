import { errorMessage } from "./error-message.ts";
import { log } from "./log.ts";
import { markError } from "./telemetry/span.ts";

// Change listeners. A failing one (a send on a closed socket) never breaks the caller.
export class Listeners<A extends unknown[] = []> {
  private readonly set = new Set<(...args: A) => void>();

  add(listener: (...args: A) => void): () => void {
    this.set.add(listener);
    return () => {
      this.set.delete(listener);
    };
  }

  get size(): number {
    return this.set.size;
  }

  notify(...args: A): void {
    for (const listener of this.set) {
      try {
        listener(...args);
      } catch (err) {
        log("listeners").error("change listener failed", { err });
        markError(`change listener failed: ${errorMessage(err)}`);
      }
    }
  }
}
