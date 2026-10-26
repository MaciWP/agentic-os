import type { Database } from "bun:sqlite";
import type { MailThread } from "../../../shared/mail-inbox.ts";
import type {
  ItemResult,
  MailAccount,
  NewProposal,
  Proposal,
  ProposalItem,
} from "../../../shared/mail-sort.ts";
import { log } from "../../log.ts";
import { ProviderError } from "../../provider-error.ts";
import { mapLimit } from "../google/client.ts";
import { GoogleReconnect, grantedScopes, MODIFY_SCOPE } from "../google/oauth.ts";
import type { GoogleReads } from "../google/routes.ts";
import type { MacBatchItem } from "../mac/outlook.ts";
import type { MacReads } from "../mac/routes.ts";
import { MacError } from "../mac/run.ts";
import { MailSortError, type ProposalStore } from "./store.ts";

// The mail categorizer's write side (plan phase 6, ADR 0002). An agent proposes; the server
// checks every mail and folder against its own read of the account; only the user's click in
// AgenticMac's native dialog applies, for both accounts. Moves and trash only: never a send,
// never a delete for good. Each mail sorted is logged without its body.

type Seen = { from: string; subject: string | null };
export type OutsidePage = { threads: MailThread[]; next: string | null; total: number };

// One account as the categorizer sees it.
export type Side = {
  // How the agent names a mail of this account, for its error messages.
  ids: string;
  inbox: (fresh: boolean) => Promise<Map<string, Seen>>;
  // Where a mail may be moved: the user's own folders or labels, by path or name.
  folders: () => Promise<string[]>;
  // It can archive under no folder and create the folders a proposal names as new.
  extras: boolean;
  // Mail out of the inbox under no folder, a page at a time, and all it has read of it since
  // the last first page: what a proposal may name besides the inbox (Gmail only).
  outside?: {
    read: (page?: string) => Promise<OutsidePage>;
    seen: () => Map<string, Seen>;
  };
  // Shows the batch in the native dialog and applies it once the user clicks: a result per
  // mail. A "no" is MacError "cancelled", and nothing changed.
  apply: (items: ProposalItem[]) => Promise<Map<string, ItemResult>>;
  // The inbox changed: the next read goes to the account.
  changed: () => void;
};

const batch = (items: ProposalItem[]): MacBatchItem[] =>
  items.map((i) => ({
    messageId: i.id,
    op: i.op === "trash" ? "trash" : "move",
    folder: i.folder ?? "",
  }));

// What the dialog shows for Gmail, which only asks: an archive and a new label read as such.
const shown = (items: ProposalItem[]): MacBatchItem[] =>
  items.map((i) =>
    i.op === "trash"
      ? { messageId: i.id, op: "trash", folder: "" }
      : {
          messageId: i.id,
          op: "move",
          folder:
            i.op === "archive"
              ? "Archivar (quitar de la bandeja)"
              : `${i.folder}${i.newFolder ? " (carpeta nueva)" : ""}`,
        },
  );

const OUTLOOK_RESULTS = new Set<ItemResult>(["ok", "not_found", "no_folder"]);

export function outlookSide(reads: MacReads): Side {
  const inbox = async (fresh: boolean) =>
    new Map(
      (await reads.inbox.get({ fresh })).messages.map((m) => [
        m.messageId,
        { from: m.from, subject: m.subject },
      ]),
    );
  return {
    ids: "Outlook mails are named by their messageId (from `aos mail inbox work`), never by id",
    inbox,
    extras: false,
    folders: async () =>
      (await reads.folders.get()).folders.filter((f) => f.role === null).map((f) => f.path),
    async apply(items) {
      try {
        const results = await reads.client.apply(batch(items));
        return new Map(
          results.map((r) => [
            r.messageId,
            OUTLOOK_RESULTS.has(r.result as ItemResult) ? (r.result as ItemResult) : "error",
          ]),
        );
      } catch (err) {
        if (!(err instanceof MacError && err.code === "timeout")) throw err;
        // The helper's deadline counts the dialog and the moves; its results are lost. What
        // left the inbox went somewhere; if nothing did, nothing was applied.
        const now = await inbox(true);
        if (items.every((i) => now.has(i.id))) throw err;
        return new Map(items.map((i) => [i.id, now.has(i.id) ? "error" : "unknown"]));
      }
    },
    changed: () => reads.inbox.invalidate(),
  };
}

const insufficient = (err: unknown) =>
  err instanceof ProviderError && err.status === 403 && err.reason === "insufficientPermissions";

export function gmailSide(
  reads: GoogleReads,
  confirm: (batch: MacBatchItem[]) => Promise<void>,
  db: Database,
): Side {
  let outside = new Map<string, Seen>();
  return {
    ids: "Gmail mails are named by their thread id",
    extras: true,
    outside: {
      async read(page) {
        const read = await reads.client.outside(page);
        if (!page) outside = new Map();
        for (const t of read.threads) outside.set(t.id, { from: t.from, subject: t.subject });
        return read;
      },
      seen: () => outside,
    },
    inbox: async (fresh) =>
      new Map(
        (await reads.inbox.get({ fresh })).threads.map((t) => [
          t.id,
          { from: t.from, subject: t.subject },
        ]),
      ),
    folders: async () => (await reads.client.labels()).map((l) => l.name),
    async apply(items) {
      // Asked before the dialog, so the user never confirms what Google would refuse.
      if (!grantedScopes(db).includes(MODIFY_SCOPE))
        throw new GoogleReconnect("sorting Gmail needs the gmail.modify permission");
      await confirm(shown(items));
      const labels = new Map((await reads.client.labels()).map((l) => [l.name, l.id]));
      let refused = 0;
      // The new labels the user kept, before any move into them; one that fails leaves its
      // mail where it was.
      const made = new Set<string>();
      for (const name of new Set(items.flatMap((i) => (i.newFolder && i.folder ? [i.folder] : []))))
        if (!labels.has(name))
          try {
            labels.set(name, await reads.client.createLabel(name));
            made.add(name);
          } catch (err) {
            if (insufficient(err)) refused++;
            log("mail").warn("could not create a Gmail label", { label: name, err });
          }
      // ponytail: 4 at a time inside the quota bucket (10 units each); a batch call when 500
      // threads take too long.
      const results = await mapLimit(items, 4, async (item): Promise<ItemResult> => {
        const labelId = item.folder === null ? undefined : labels.get(item.folder);
        if (item.op === "move" && !labelId) return "no_folder";
        try {
          await reads.client.sortThread(
            item.id,
            item.op === "trash"
              ? { trash: true }
              : item.op === "archive"
                ? { archive: true }
                : { labelId: labelId as string },
          );
          return "ok";
        } catch (err) {
          if (insufficient(err)) refused++;
          return err instanceof ProviderError && err.status === 404 ? "not_found" : "error";
        }
      });
      if (made.size > 0) log("mail").info("created Gmail labels", { labels: [...made] });
      if (refused > 0 && !results.includes("ok"))
        throw new GoogleReconnect("Gmail refused the move: reconnect Google with gmail.modify");
      return new Map(items.map((item, i) => [item.id, results[i] as ItemResult]));
    },
    // The profile lists the labels: a new one must show in the next read.
    changed: () => {
      reads.inbox.invalidate();
      reads.profile.invalidate();
    },
  };
}

const MAX_PROBLEMS = 20;

export function mailSorter(store: ProposalStore, sides: Record<MailAccount, Side>) {
  // Proposals with a dialog open or a batch running: a second click waits for the first.
  const busy = new Set<number>();

  // Checks a proposal against the account the agent read (the same cached inbox and folders)
  // and keeps it pending; it replaces the account's previous one.
  async function propose(account: MailAccount, input: NewProposal): Promise<Proposal> {
    const side = sides[account];
    const [inbox, folders] = await Promise.all([side.inbox(false), side.folders()]);
    const outside = side.outside?.seen() ?? new Map<string, Seen>();
    const known = new Set(folders);
    const problems = input.items.flatMap((item, i) => [
      ...(inbox.has(item.id)
        ? []
        : !outside.has(item.id)
          ? [
              `items[${i}]: ${item.id} is not in the inbox${side.outside ? " nor read outside it" : ""}`,
            ]
          : item.op === "archive"
            ? [`items[${i}]: ${item.id} is already out of the inbox`]
            : []),
      ...(item.op === "move" && !item.newFolder && !known.has(item.folder ?? "")
        ? [`items[${i}]: there is no folder "${item.folder}"; mark it newFolder to propose it`]
        : []),
      ...(item.newFolder && known.has(item.folder ?? "")
        ? [`items[${i}]: the folder "${item.folder}" exists; drop newFolder`]
        : []),
      ...((item.newFolder || item.op === "archive") && !side.extras
        ? [`items[${i}]: this account takes no archive and no new folder`]
        : []),
    ]);
    if (problems.length > 0)
      throw new MailSortError(
        "bad_proposal",
        [
          `Nothing saved. ${side.ids}; folders are the exact paths \`aos mail profile\` lists.`,
          ...problems.slice(0, MAX_PROBLEMS),
          ...(problems.length > MAX_PROBLEMS
            ? [`…and ${problems.length - MAX_PROBLEMS} more`]
            : []),
        ].join("\n"),
      );
    return store.create(
      account,
      input.items.map((item) => {
        const seen = (inbox.get(item.id) ?? outside.get(item.id)) as Seen;
        return {
          id: item.id,
          op: item.op,
          folder: item.op === "move" ? (item.folder ?? null) : null,
          newFolder: item.newFolder === true,
          outside: !inbox.has(item.id),
          reason: item.reason,
          from: seen.from,
          subject: seen.subject,
          result: null,
        };
      }),
    );
  }

  // Applies the mails the user kept ticked. Anything that left the inbox since is skipped as
  // "gone"; a cancelled dialog leaves the proposal pending.
  async function apply(id: number, keep: string[]): Promise<Proposal> {
    const proposal = store.get(id);
    if (proposal.status !== "pending")
      throw new MailSortError("not_pending", `mail proposal ${id} is ${proposal.status}`);
    const kept = new Set(keep);
    const unknown = keep.filter((k) => !proposal.items.some((i) => i.id === k));
    if (unknown.length > 0)
      throw new MailSortError("bad_proposal", `not in proposal ${id}: ${unknown.join(", ")}`);
    if (busy.has(id)) throw new MailSortError("busy", `mail proposal ${id} is being applied`);
    busy.add(id);
    const side = sides[proposal.account];
    try {
      const inbox = await side.inbox(true);
      // Mail read outside the inbox is not checked again: Gmail says if it is gone.
      const live = proposal.items.filter((i) => kept.has(i.id) && (i.outside || inbox.has(i.id)));
      const results = live.length > 0 ? await side.apply(live) : new Map<string, ItemResult>();
      const items = proposal.items.map((item) => ({
        ...item,
        result: !kept.has(item.id)
          ? ("skipped" as const)
          : !item.outside && !inbox.has(item.id)
            ? ("gone" as const)
            : (results.get(item.id) ?? ("error" as const)),
      }));
      for (const item of items)
        if (kept.has(item.id))
          log("mail").info("sorted", {
            account: proposal.account,
            mail: item.id,
            op: item.op,
            folder: item.folder,
            result: item.result,
          });
      side.changed();
      return store.finish(id, items);
    } finally {
      busy.delete(id);
    }
  }

  // A page of the account's mail outside the inbox, which the next proposal may name.
  async function outsidePage(account: MailAccount, page?: string): Promise<OutsidePage> {
    const outside = sides[account].outside;
    if (!outside) throw new MailSortError("not_found", "only Gmail is read outside the inbox");
    return outside.read(page);
  }

  return { propose, apply, outside: outsidePage };
}
