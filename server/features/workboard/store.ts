import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  StoredWorkSession,
  type WorkAck,
  WorkResponse,
  type WorkSession,
} from "../../../shared/workboard.ts";
import { LEDGER_KEEP_MS } from "../../retention.ts";

// Every accepted answer, by request id: a retry replays it even after the agent closed or
// republished the decision. Kept for the ledger window, like the other request ledgers.
const Answer = WorkResponse.extend({ at: z.number().nonnegative() });
const MAX_SESSIONS = 100;
const File = z.object({
  sessions: z.array(StoredWorkSession).max(MAX_SESSIONS),
  answers: z.array(Answer),
});
type File = z.infer<typeof File>;
// Sessions idle past the window are dropped, then the least recently updated beyond 100.
const pruned = (file: File): File => {
  const since = Date.now() - LEDGER_KEEP_MS;
  return {
    sessions: file.sessions
      .filter((s) => s.updatedAt >= since)
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(-MAX_SESSIONS),
    answers: file.answers.filter((a) => a.at >= since),
  };
};

// One server writer; serialized read/modify/atomic-rename prevents lost panel responses.
// This is local state, not a new database schema or a provider credential store.
export class WorkboardStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}
  private async read(): Promise<File> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8"));
      // Before the answer ledger the file was the bare session list.
      return File.parse(Array.isArray(raw) ? { sessions: raw, answers: [] } : raw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { sessions: [], answers: [] };
      throw err;
    }
  }
  private write(update: (file: File) => File) {
    const task = this.tail.then(async () => {
      const file = pruned(update(await this.read()));
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.${crypto.randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(file), { mode: 0o600 });
      await rename(tmp, this.path);
      return file.sessions;
    });
    this.tail = task.catch(() => undefined);
    return task;
  }
  async list() {
    await this.tail;
    return (await this.read()).sessions;
  }
  // `from` names a former owner the caller found released, so a resumed session can move on.
  publish(actor: string, input: WorkSession, from?: string) {
    return this.write(({ sessions: rows, answers }) => {
      const previous = rows.find((s) => s.sessionId === input.sessionId);
      if (previous && previous.actor !== actor && previous.actor !== from)
        throw Error("Session belongs to another terminal");
      const decisions = input.decisions.map((d) => {
        const old = previous?.decisions.find((x) => x.id === d.id);
        if (old && old.revision > d.revision) return old;
        if (old && old.revision === d.revision) {
          if (
            old.blocking !== d.blocking ||
            old.question !== d.question ||
            JSON.stringify(old.options) !== JSON.stringify(d.options)
          )
            throw Error("Decision changed without revision");
          if (old.requestId) return old;
        }
        return d;
      });
      const next = { ...input, decisions, actor, updatedAt: Date.now() };
      return { sessions: [...rows.filter((s) => s.sessionId !== input.sessionId), next], answers };
    });
  }
  respond(input: WorkResponse) {
    return this.write((file) => {
      const { sessions: rows, answers } = file;
      // The duplicate first: the decision may be closed or republished since it was answered.
      const done = answers.find((a) => a.requestId === input.requestId);
      if (done) {
        const { at: _, ...answer } = done;
        if (JSON.stringify(answer) !== JSON.stringify(WorkResponse.parse(input)))
          throw Error("request_conflict: this request id already names another answer");
        return file;
      }
      const s = rows.find((s) => s.sessionId === input.sessionId);
      const d = s?.decisions.find((d) => d.id === input.decisionId);
      if (!s || !d || d.revision !== input.revision) throw Error("Decision no longer current");
      if (d.requestId === input.requestId && d.response === input.response) return file;
      if (!["pending", "failed"].includes(d.state))
        throw Error("Decision already answered or cancelled");
      const next = rows.map((s) =>
        s.sessionId !== input.sessionId
          ? s
          : {
              ...s,
              decisions: s.decisions.map((d) =>
                d.id !== input.decisionId
                  ? d
                  : {
                      ...d,
                      state: "queued" as const,
                      response: input.response,
                      requestId: input.requestId,
                      error: undefined,
                    },
              ),
            },
      );
      return { sessions: next, answers: [...answers, { ...input, at: Date.now() }] };
    });
  }
  ack(actor: string, input: WorkAck) {
    return this.write((file) => {
      const rows = file.sessions;
      const s = rows.find((s) => s.sessionId === input.sessionId);
      const d = s?.decisions.find((d) => d.id === input.decisionId);
      if (
        !s ||
        s.actor !== actor ||
        !d ||
        d.revision !== input.revision ||
        d.requestId !== input.requestId ||
        !["queued", "delivered", "failed"].includes(d.state)
      )
        throw Error("Response is no longer pending for this terminal");
      if (d.state === "delivered") return file;
      const sessions = rows.map((s) =>
        s.sessionId !== input.sessionId
          ? s
          : {
              ...s,
              decisions: s.decisions.map((d) =>
                d.id !== input.decisionId
                  ? d
                  : {
                      ...d,
                      state: input.delivered ? ("delivered" as const) : ("failed" as const),
                      error: input.error,
                    },
              ),
            },
      );
      return { ...file, sessions };
    });
  }
}
