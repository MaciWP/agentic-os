import type { Database } from "bun:sqlite";
import { contentVersion } from "../../recovery.ts";
import { keptSince } from "../../retention.ts";
import {
  type LaunchSpec,
  type LaunchStatus,
  type TerminalInfo,
  TerminalRecord,
} from "./contract.ts";
import { LaunchError } from "./harness.ts";

type RecordRow = { fingerprint: string; result: string | null; error: string | null };

// The claim is durable before any await/spawn. An interrupted claim is never rerun.
// `error` is stored only for a LaunchError: every one is thrown before the spawn, so nothing
// started and the refusal replays as `rejected`. Any other failure leaves it `uncertain`.
export class LaunchRequests {
  private pending = new Map<string, Promise<TerminalInfo>>();
  constructor(private db: Database) {}
  get(id: string): LaunchStatus | null {
    const row = this.db
      .query<RecordRow, [string]>(
        "SELECT fingerprint,result,error FROM terminal_launch_requests WHERE request_id=?",
      )
      .get(id);
    if (!row) return null;
    return {
      fingerprint: row.fingerprint,
      state: row.result
        ? "finished"
        : this.pending.has(id)
          ? "pending"
          : row.error !== null
            ? "rejected"
            : "uncertain",
      terminal: row.result ? TerminalRecord.parse(JSON.parse(row.result)) : null,
      error: row.error,
    };
  }
  run(spec: LaunchSpec, start: () => Promise<TerminalInfo>): Promise<TerminalInfo> {
    if (!spec.requestId) return start(); // Older local clients have no automatic retry contract.
    const id = spec.requestId;
    const fingerprint = spec.requestFingerprint ?? contentVersion(JSON.stringify(spec));
    const found = this.db
      .query<RecordRow, [string]>(
        "SELECT fingerprint,result,error FROM terminal_launch_requests WHERE request_id=?",
      )
      .get(id);
    if (found) {
      if (found.fingerprint !== fingerprint)
        return Promise.reject(new LaunchError("request_conflict: launch input changed"));
      const pending = this.pending.get(id);
      if (pending) return pending;
      if (found.result) return Promise.resolve(TerminalRecord.parse(JSON.parse(found.result)));
      if (found.error !== null) return Promise.reject(new LaunchError(found.error));
      return Promise.reject(
        new LaunchError(
          `launch_uncertain: inspect terminals before starting a new request (${id})`,
        ),
      );
    }
    // Old rows go first; a launch still in flight is never pruned.
    const running = [...this.pending.keys()];
    this.db.run(
      `DELETE FROM terminal_launch_requests WHERE created_at < ? AND request_id NOT IN (${running.map(() => "?").join(",")})`,
      [keptSince(), ...running],
    );
    this.db.run("INSERT INTO terminal_launch_requests VALUES (?,?,NULL,NULL,?)", [
      id,
      fingerprint,
      new Date().toISOString(),
    ]);
    const task = Promise.resolve()
      .then(start)
      .then(
        (result) => {
          this.db.run("UPDATE terminal_launch_requests SET result=? WHERE request_id=?", [
            JSON.stringify(result),
            id,
          ]);
          return result;
        },
        (err) => {
          if (err instanceof LaunchError)
            this.db.run("UPDATE terminal_launch_requests SET error=? WHERE request_id=?", [
              err.message,
              id,
            ]);
          throw err;
        },
      )
      .finally(() => this.pending.delete(id));
    this.pending.set(id, task);
    return task;
  }
}
