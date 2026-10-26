import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { z } from "zod";
import {
  type Attempt,
  Consultation,
  type ConsultationInput,
  type CoordMessage,
  type MessageInput,
  MessageRecord,
  Reservation,
  ReservationAudit,
} from "../../../shared/coordination.ts";
import { log } from "../../log.ts";
import { hasGitSegment, isInside } from "../../paths.ts";
import { keptSince } from "../../retention.ts";

export class CoordinationError extends Error {
  constructor(
    readonly code: string,
    detail: string,
    readonly status: 400 | 403 | 404 | 409 | 503 = 409,
  ) {
    super(`${code}: ${detail}`);
  }
}
// The audit is shown 100 at a time; older entries beyond this many are dropped on release.
export const AUDIT_KEPT = 1000;
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

export class CoordinationStore {
  constructor(
    readonly db: Database,
    readonly changed: () => void = () => {},
  ) {}
  revision() {
    return (
      this.db
        .query<{ revision: number }, []>("SELECT revision FROM coordination_revision WHERE id=1")
        .get()?.revision ?? 0
    );
  }
  private transaction<T>(run: () => T): T {
    const nested = this.db.inTransaction;
    const before = this.revision();
    const result = this.db.transaction(run).immediate();
    if (!nested && this.revision() !== before) {
      try {
        this.changed();
      } catch (err) {
        log("coordination").error("notification failed", { err });
      }
    }
    return result;
  }
  private touch() {
    this.db.run("UPDATE coordination_revision SET revision=revision+1 WHERE id=1");
  }
  private rows(kind: string) {
    return this.db
      .query<{ body: string }, [string]>(
        "SELECT body FROM coordination_records WHERE kind=? ORDER BY rowid DESC",
      )
      .all(kind);
  }
  messages() {
    return this.rows("message").map((r) => MessageRecord.parse(JSON.parse(r.body)));
  }
  consultations() {
    return this.rows("consultation").map((r) => Consultation.parse(JSON.parse(r.body)));
  }
  getMessage(id: string) {
    return this.get("message", id, MessageRecord);
  }
  getConsultation(id: string) {
    return this.get("consultation", id, Consultation);
  }
  private get<T>(kind: string, id: string, schema: z.ZodType<T>): T {
    const r = this.db
      .query<{ body: string }, [string, string]>(
        "SELECT body FROM coordination_records WHERE kind=? AND id=?",
      )
      .get(kind, id);
    if (!r) throw new CoordinationError("not_found", id, 404);
    return schema.parse(JSON.parse(r.body));
  }
  private duplicate<T>(key: string, body: unknown, schema: z.ZodType<T>): T | undefined {
    const r = this.db
      .query<{ body: string; request_body: string }, [string]>(
        "SELECT body, request_body FROM coordination_records WHERE request_key=?",
      )
      .get(key);
    if (!r) return;
    if (r.request_body !== JSON.stringify(body))
      throw new CoordinationError(
        "request_conflict",
        "this request id already names different input",
      );
    return schema.parse(JSON.parse(r.body));
  }
  private insert(kind: string, key: string, input: unknown, data: { id: string }) {
    this.db.run("INSERT INTO coordination_records VALUES (?,?,?,?,?)", [
      data.id,
      kind,
      key,
      JSON.stringify(input),
      JSON.stringify(data),
    ]);
    this.touch();
  }
  // The record a retry of this request already created, so a replay skips checks on state
  // that may have changed since (the recipient may be gone). Throws on changed input.
  existingMessage(from: string, input: z.infer<typeof MessageInput>): CoordMessage | undefined {
    return this.duplicate(`message:${from}:${input.requestId}`, input, MessageRecord);
  }
  message(from: string, input: z.infer<typeof MessageInput>): CoordMessage {
    return this.transaction(() => {
      const key = `message:${from}:${input.requestId}`;
      const duplicate = this.duplicate(key, input, MessageRecord);
      if (duplicate) return duplicate;
      const parent = input.replyTo ? this.getMessage(input.replyTo) : undefined;
      if (parent && (parent.to !== from || parent.from !== input.to))
        throw new CoordinationError(
          "reply_owner",
          "only the recipient can reply to the sender",
          403,
        );
      // Settled messages leave the ledger after the retention window; a message still
      // pending or being delivered stays until it settles.
      this.db.run(
        `DELETE FROM coordination_records WHERE kind='message'
           AND json_extract(body,'$.status') NOT IN ('pending','delivering')
           AND json_extract(body,'$.createdAt') < ?`,
        [keptSince()],
      );
      const id = uuid();
      const record: CoordMessage = {
        ...input,
        id,
        from,
        threadId: parent?.threadId ?? id,
        createdAt: now(),
        status: "pending",
        error: null,
      };
      this.insert("message", key, input, record);
      // Answered means a durable reply exists, independently of its terminal delivery.
      if (parent) this.updateMessage(parent.id, "answered");
      return record;
    });
  }
  claimMessage(id: string): boolean {
    return this.transaction(() => {
      const m = this.getMessage(id);
      if (m.status !== "pending") return false;
      this.save("message", { ...m, status: "delivering" });
      return true;
    });
  }
  updateMessage(id: string, status: CoordMessage["status"], error: string | null = null) {
    return this.transaction(() => {
      const m = this.getMessage(id);
      this.save("message", { ...m, status: m.status === "answered" ? "answered" : status, error });
    });
  }
  recoverMessages() {
    for (const m of this.messages())
      if (m.status === "delivering")
        this.updateMessage(m.id, "uncertain", "server restarted during delivery; not resent");
  }
  private save<T extends { id: string }>(kind: string, data: T) {
    this.db.run("UPDATE coordination_records SET body=? WHERE kind=? AND id=?", [
      JSON.stringify(data),
      kind,
      data.id,
    ]);
    this.touch();
  }
  createConsultation(
    author: string,
    input: z.infer<typeof ConsultationInput>,
    source: string,
    contextText: string,
  ) {
    return this.transaction(() => {
      const key = `consultation:${author}:${input.requestId}`;
      const duplicate = this.duplicate(key, input, Consultation);
      if (duplicate) return duplicate;
      const q: Consultation = {
        id: uuid(),
        author,
        input,
        contextText,
        source,
        createdAt: now(),
        state: "preparing",
        approvedAt: null,
        fingerprint: null,
        snapshot: null,
        snapshotInfo: null,
        error: null,
        attempts: [],
      };
      this.insert("consultation", key, input, q);
      return q;
    });
  }
  updateConsultation(id: string, update: (q: Consultation) => Consultation) {
    return this.transaction(() => {
      const q = Consultation.parse(update(this.getConsultation(id)));
      this.save("consultation", q);
      return q;
    });
  }
  updateAttempt(id: string, attempt: string, patch: Partial<Attempt>) {
    return this.updateConsultation(id, (q) => ({
      ...q,
      attempts: q.attempts.map((a) => (a.id === attempt ? { ...a, ...patch } : a)),
    }));
  }
  removeConsultation(id: string) {
    return this.transaction(() => {
      this.db.run("DELETE FROM coordination_records WHERE kind='consultation' AND id=?", [id]);
      this.touch();
    });
  }
  reservations() {
    return this.db
      .query<{ body: string }, []>("SELECT body FROM coordination_reservations ORDER BY path")
      .all()
      .map((r) => Reservation.parse(JSON.parse(r.body)));
  }
  reserve(
    owner: string,
    generation: string,
    root: string,
    paths: string[],
    reason: string,
  ): Reservation[] {
    return this.transaction(() => {
      const current = this.reservations();
      const conflicts = current.filter(
        (r) =>
          paths.includes(r.path) &&
          (r.owner !== owner || r.generation !== generation || r.status !== "active"),
      );
      if (conflicts.length)
        throw new CoordinationError(
          "reserved",
          JSON.stringify(
            conflicts.map((r) => ({
              path: r.path,
              owner: r.owner,
              reason: r.reason,
              status: r.status,
            })),
          ),
        );
      const result = [...new Set(paths)].map((path) => {
        const existing = current.find((r) => r.path === path);
        if (existing) return existing;
        const r: Reservation = {
          id: uuid(),
          owner,
          generation,
          root,
          path,
          reason,
          status: "active",
          createdAt: now(),
        };
        this.db.run("INSERT INTO coordination_reservations VALUES (?,?,?)", [
          r.id,
          path,
          JSON.stringify(r),
        ]);
        return r;
      });
      this.touch();
      return result;
    });
  }
  release(owner: string, id: string) {
    return this.transaction(() => {
      const r = this.reservations().find((r) => r.id === id);
      if (!r) return;
      if (owner !== "user" && r.owner !== owner)
        throw new CoordinationError(
          "reservation_owner",
          "only the owner or the user can release",
          403,
        );
      this.db.run("DELETE FROM coordination_reservations WHERE id=?", [id]);
      // Keep an audit entry even when a user overrides a reservation.
      this.db.run("INSERT INTO coordination_audit VALUES (?,?)", [
        uuid(),
        JSON.stringify({
          actor: owner,
          owner: r.owner,
          path: r.path,
          action: "release",
          at: now(),
        }),
      ]);
      this.db.run(
        "DELETE FROM coordination_audit WHERE rowid NOT IN (SELECT rowid FROM coordination_audit ORDER BY rowid DESC LIMIT ?)",
        [AUDIT_KEPT],
      );
      this.touch();
    });
  }
  audit() {
    return this.db
      .query<{ body: string }, []>(
        "SELECT body FROM coordination_audit ORDER BY rowid DESC LIMIT 100",
      )
      .all()
      .map((r) => ReservationAudit.parse(JSON.parse(r.body)));
  }
  reconcile(list: { id: string; state: string; startedAt: string }[]) {
    return this.transaction(() => {
      for (const r of this.reservations()) {
        if (r.owner === "user") continue;
        const t = list.find((t) => t.id === r.owner);
        if (t?.startedAt === r.generation && (t.state === "exited" || t.state === "failed"))
          this.release(r.owner, r.id);
        else if (
          (t?.state !== "running" || t.startedAt !== r.generation) &&
          r.status !== "orphaned"
        ) {
          this.db.run("UPDATE coordination_reservations SET body=? WHERE id=?", [
            JSON.stringify({ ...r, status: "orphaned" }),
            r.id,
          ]);
          this.touch();
        }
      }
    });
  }
}

export async function reservePaths(root: string, paths: string[]): Promise<string[]> {
  const base = realpathSync(root);
  return [
    ...new Set(
      paths.map((path) => {
        if (
          isAbsolute(path) ||
          path.includes("\0") ||
          path.split(/[\\/]/).includes("..") ||
          hasGitSegment(path)
        )
          throw new CoordinationError("bad_path", path, 400);
        let probe = resolve(base, path);
        const rest: string[] = [];
        while (!lstatSync(probe, { throwIfNoEntry: false })) {
          const parent = dirname(probe);
          if (parent === probe) throw new CoordinationError("bad_path", path, 400);
          rest.unshift(probe.slice(parent.length + 1));
          probe = parent;
        }
        let canonical: string;
        try {
          canonical = realpathSync(probe);
        } catch {
          throw new CoordinationError("bad_path", path, 400);
        }
        const result = join(canonical, ...rest);
        const rel = relative(base, result);
        if (
          !rel ||
          !isInside(base, result) ||
          hasGitSegment(rel) ||
          (existsSync(result) && !statSync(result).isFile())
        )
          throw new CoordinationError("bad_path", path, 400);
        return result;
      }),
    ),
  ];
}
