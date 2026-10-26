import type { Attempt, Consultation, Participant } from "../../../shared/coordination.ts";
import { errorMessage } from "../../error-message.ts";
import { CoordinationError, type CoordinationStore } from "./store.ts";

type Execute = (
  q: Consultation,
  a: Attempt,
  signal: AbortSignal,
) => Promise<{ result: string; usage: Record<string, unknown> | null }>;
// A new attempt for one participant, queued until the host runs it.
export function newAttempt(participant: Participant, kind: Attempt["kind"] = "opinion"): Attempt {
  return {
    id: crypto.randomUUID(),
    participant,
    kind,
    state: "queued",
    startedAt: null,
    endedAt: null,
    result: null,
    error: null,
    usage: null,
  };
}
export class ConsultationRunner {
  private jobs = new Map<string, { abort: AbortController; done: Promise<void> }>();
  constructor(
    readonly store: CoordinationStore,
    private execute: Execute,
  ) {}
  running() {
    return this.jobs.size;
  }
  async settled() {
    await Promise.all([...this.jobs.values()].map((j) => j.done));
  }
  recover() {
    for (const q of this.store.consultations())
      if (["running", "approved"].includes(q.state))
        this.store.updateConsultation(q.id, (q) => ({
          ...q,
          state: "finished",
          error: "Host restarted; interrupted attempts are never relaunched automatically.",
          attempts: q.attempts.map((a) =>
            ["running", "queued"].includes(a.state)
              ? { ...a, state: "interrupted", endedAt: new Date().toISOString() }
              : a,
          ),
        }));
  }
  async start(id: string) {
    if (this.jobs.has(id)) return;
    let claimed = false;
    const q = this.store.updateConsultation(id, (q) => {
      if (["running", "finished", "cancelled"].includes(q.state)) return q;
      if (q.state !== "approved" || !q.snapshot || !q.attempts.length)
        throw new CoordinationError(
          "approval_required",
          "Approve the frozen batch before launching",
        );
      claimed = true;
      return { ...q, state: "running" };
    });
    if (!claimed) return;
    const abort = new AbortController();
    const done = Promise.all(
      q.attempts
        .filter((a) => a.state === "queued")
        .map(async (a) => {
          const controller = new AbortController();
          const cancel = () => controller.abort();
          abort.signal.addEventListener("abort", cancel, { once: true });
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, q.input.timeoutMs);
          this.store.updateAttempt(id, a.id, {
            state: "running",
            startedAt: new Date().toISOString(),
          });
          try {
            const result = await this.execute(q, a, controller.signal);
            if (controller.signal.aborted) throw Error("Aborted");
            this.store.updateAttempt(id, a.id, {
              ...result,
              state: "succeeded",
              endedAt: new Date().toISOString(),
            });
          } catch (err) {
            this.store.updateAttempt(id, a.id, {
              state: timedOut ? "timed_out" : abort.signal.aborted ? "cancelled" : "failed",
              error: errorMessage(err),
              endedAt: new Date().toISOString(),
            });
          } finally {
            clearTimeout(timer);
            abort.signal.removeEventListener("abort", cancel);
          }
        }),
    )
      .then(() => {
        this.store.updateConsultation(id, (current) => ({
          ...current,
          state: abort.signal.aborted ? "cancelled" : "finished",
        }));
      })
      .finally(() => {
        this.jobs.delete(id);
      });
    this.jobs.set(id, { abort, done });
  }
  async cancel(id: string) {
    const job = this.jobs.get(id);
    if (job) {
      job.abort.abort();
      await job.done;
    } else
      this.store.updateConsultation(id, (q) => {
        if (["finished", "failed", "cancelled"].includes(q.state)) return q;
        return {
          ...q,
          state: "cancelled",
          attempts: q.attempts.map((a) =>
            a.state === "queued"
              ? { ...a, state: "cancelled", endedAt: new Date().toISOString() }
              : a,
          ),
        };
      });
  }
  async stopAll() {
    await Promise.all([...this.jobs.keys()].map((id) => this.cancel(id)));
  }
}
