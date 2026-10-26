import type { CoordMessage } from "../../../shared/coordination.ts";
import { errorMessage } from "../../error-message.ts";
import { submit, type Writer } from "../terminals/submit.ts";
import type { CoordinationStore } from "./store.ts";

export type Outcome = { status: CoordMessage["status"]; error: string | null };
// Where a message to `agent@machine` goes: held for the hub to collect (on a worker), or handed
// to that machine now (on the hub). See remote.ts.
export type Remote = {
  held: (to: string) => boolean;
  relay: (m: CoordMessage) => Promise<Outcome>;
};

type Target = Writer & {
  get(
    id: string,
  ):
    | Promise<{ state: string; harness: string } | undefined>
    | { state: string; harness: string }
    | undefined;
};
// One text/Enter pair at a time per recipient. Delivery never attaches or interrupts.
export class Messenger {
  private readonly tails = new Map<string, Promise<void>>();
  constructor(
    private readonly store: CoordinationStore,
    private readonly terminals: Target,
    private readonly enterDelay = 150,
    private readonly remote?: Remote,
  ) {}
  deliver(id: string): Promise<void> {
    const message = this.store.getMessage(id);
    const prev = this.tails.get(message.to) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.send(id));
    this.tails.set(message.to, next);
    return next.finally(() => {
      if (this.tails.get(message.to) === next) this.tails.delete(message.to);
    });
  }
  private async send(id: string) {
    const to = this.store.getMessage(id).to;
    if (to.includes("@")) return this.sendAway(id, to);
    if (!this.store.claimMessage(id)) return;
    const m = this.store.getMessage(id);
    let attempted = false;
    try {
      if (m.to === "user") {
        this.store.updateMessage(id, "delivered");
        return;
      }
      const t = await this.terminals.get(m.to);
      if (t?.state !== "running" || !["claude", "codex", "grok"].includes(t.harness)) {
        this.store.updateMessage(id, "failed", "recipient is not a running managed agent");
        return;
      }
      const text = `[Agentic OS message ${m.id} from ${m.from}]\n${m.text}\n\nReply with: aos message reply ${m.id} --agent ${m.to} --text-file <file>. Use aos help for coordination and file reservations.`;
      attempted = true;
      await submit(this.terminals, m.to, text, this.enterDelay);
      this.store.updateMessage(id, "delivered");
    } catch (err) {
      this.store.updateMessage(id, attempted ? "uncertain" : "failed", errorMessage(err));
    }
  }
  private async sendAway(id: string, to: string) {
    if (this.remote?.held(to)) return;
    if (!this.store.claimMessage(id)) return;
    if (!this.remote) {
      this.store.updateMessage(id, "failed", `no machine reaches ${to}`);
      return;
    }
    const { status, error } = await this.remote.relay(this.store.getMessage(id));
    this.store.updateMessage(
      id,
      status === "pending" || status === "delivering" ? "uncertain" : status,
      error,
    );
  }
}
