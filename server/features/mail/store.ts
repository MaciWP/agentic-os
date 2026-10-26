import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  type Decision,
  type MailAccount,
  type Proposal,
  ProposalItem,
} from "../../../shared/mail-sort.ts";

const STATUS = {
  bad_proposal: 400,
  provider_disabled: 400,
  user_approval_required: 403,
  not_found: 404,
  not_pending: 409,
  busy: 409,
} as const;

export class MailSortError extends Error {
  readonly status: (typeof STATUS)[keyof typeof STATUS];
  constructor(
    readonly code: keyof typeof STATUS,
    detail: string,
  ) {
    super(detail);
    this.status = STATUS[code];
  }
}

type Row = {
  id: number;
  account: MailAccount;
  created_at: string;
  status: Proposal["status"];
  items: string;
};
const Items = z.array(ProposalItem);

function proposalOf(r: Row): Proposal {
  const items = Items.safeParse(JSON.parse(r.items));
  if (!items.success) throw new Error(`mail proposal ${r.id} has unreadable items`);
  return {
    id: r.id,
    account: r.account,
    createdAt: r.created_at,
    status: r.status,
    items: items.data,
  };
}

// The categorizer's proposals (migrations/013_today.sql). One stays pending per account: a new
// one replaces it, so the review always shows the agent's latest read of the inbox.
export class ProposalStore {
  constructor(
    private readonly db: Database,
    private readonly changed: () => void = () => {},
  ) {}

  create(account: MailAccount, items: ProposalItem[]): Proposal {
    const row = this.db.transaction(() => {
      this.db.run(
        "UPDATE mail_proposals SET status = 'discarded' WHERE account = ? AND status = 'pending'",
        [account],
      );
      return this.db
        .query<Row, [string, string, string]>(
          `INSERT INTO mail_proposals (account, created_at, status, items)
           VALUES (?, ?, 'pending', ?) RETURNING *`,
        )
        .get(account, new Date().toISOString(), JSON.stringify(items)) as Row;
    })();
    this.changed();
    return proposalOf(row);
  }

  pending(account: MailAccount): Proposal | null {
    const row = this.db
      .query<Row, [string]>(
        "SELECT * FROM mail_proposals WHERE account = ? AND status = 'pending' ORDER BY id DESC LIMIT 1",
      )
      .get(account);
    return row ? proposalOf(row) : null;
  }

  get(id: number): Proposal {
    const row = this.db.query<Row, [number]>("SELECT * FROM mail_proposals WHERE id = ?").get(id);
    if (!row) throw new MailSortError("not_found", `no mail proposal ${id}`);
    return proposalOf(row);
  }

  // Applied, with what became of each mail.
  finish(id: number, items: ProposalItem[]): Proposal {
    return this.leave(id, "applied", items);
  }

  // The user's ticks on the proposals applied since `since`, by sender, op and folder, most
  // decided first. Mail that had left the inbox or failed says nothing about the user.
  decisions(account: MailAccount, since: Date, top = 100): Decision[] {
    const rows = this.db
      .query<Row, [string, string]>(
        "SELECT * FROM mail_proposals WHERE account = ? AND status = 'applied' AND created_at >= ?",
      )
      .all(account, since.toISOString());
    const by = new Map<string, Decision>();
    for (const item of rows.flatMap((r) => proposalOf(r).items)) {
      if (item.result !== "ok" && item.result !== "skipped") continue;
      const key = JSON.stringify([item.from, item.op, item.folder]);
      const d = by.get(key) ?? {
        from: item.from,
        op: item.op,
        folder: item.folder,
        kept: 0,
        skipped: 0,
      };
      if (item.result === "ok") d.kept += 1;
      else d.skipped += 1;
      by.set(key, d);
    }
    return [...by.values()].sort((a, b) => b.kept + b.skipped - (a.kept + a.skipped)).slice(0, top);
  }

  discard(id: number): Proposal {
    return this.leave(id, "discarded", this.get(id).items);
  }

  private leave(id: number, status: "applied" | "discarded", items: ProposalItem[]): Proposal {
    const row = this.db
      .query<Row, [string, string, number]>(
        `UPDATE mail_proposals SET status = ?, items = ? WHERE id = ? AND status = 'pending'
         RETURNING *`,
      )
      .get(status, JSON.stringify(items), id);
    if (!row)
      throw new MailSortError("not_pending", `mail proposal ${id} is ${this.get(id).status}`);
    this.changed();
    return proposalOf(row);
  }
}
