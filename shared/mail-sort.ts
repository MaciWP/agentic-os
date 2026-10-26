import { z } from "zod";

// What a mail categorizer agent proposes for one account and what the user applies of it
// (server/features/mail). The agent proposes; only the user's click on the Mac applies.

export const MailAccount = z.enum(["work", "personal"]);
export type MailAccount = z.infer<typeof MailAccount>;

// The saved prompt each column launches; the server seeds them once and the user can edit them.
export const SORT_PROMPT: Record<MailAccount, string> = {
  work: "Categorizar Trabajo",
  personal: "Categorizar Personal",
};
export const sortPromptId = (account: MailAccount) => `prompts:${SORT_PROMPT[account]}.md`;

// The helper's batch limit (scripts/mac/AgenticMac.swift APPLY_MAX).
export const MAX_PROPOSAL = 500;

// One mail by the account's own id for it: Outlook's RFC Message-ID, Gmail's thread id.
const MailId = z.string().trim().min(1).max(998);
// "archive" takes a mail out of the inbox under no label (Gmail only).
const Op = z.enum(["move", "trash", "archive"]);
const Proposed = z.strictObject({
  id: MailId,
  op: Op,
  // The folder (Outlook) or label (Gmail) to move to; a trash or an archive has none.
  folder: z.string().trim().min(1).max(300).optional(),
  // The label does not exist yet: it is created when the user applies (Gmail only).
  newFolder: z.boolean().optional(),
  reason: z.string().trim().min(1).max(300),
});

export const NewProposal = z
  .strictObject({ items: z.array(Proposed).min(1).max(MAX_PROPOSAL) })
  .superRefine(({ items }, ctx) => {
    const seen = new Set<string>();
    items.forEach((item, i) => {
      if (item.op === "move" && !item.folder)
        ctx.addIssue({
          code: "custom",
          path: ["items", i, "folder"],
          message: "a move names a folder",
        });
      if (item.op !== "move" && item.folder)
        ctx.addIssue({
          code: "custom",
          path: ["items", i, "folder"],
          message: `a${item.op === "trash" ? " trash" : "n archive"} names no folder`,
        });
      if (item.op !== "move" && item.newFolder)
        ctx.addIssue({
          code: "custom",
          path: ["items", i, "newFolder"],
          message: "only a move goes to a new folder",
        });
      if (seen.has(item.id))
        ctx.addIssue({
          code: "custom",
          path: ["items", i, "id"],
          message: "this mail is proposed twice",
        });
      seen.add(item.id);
    });
  });
export type NewProposal = z.infer<typeof NewProposal>;

// What became of each mail: "skipped" the user unticked it, "gone" it had left the inbox before
// the click, "unknown" it left the inbox but the helper never said how (it timed out).
export const ItemResult = z.enum([
  "ok",
  "skipped",
  "gone",
  "not_found",
  "no_folder",
  "error",
  "unknown",
]);
export type ItemResult = z.infer<typeof ItemResult>;

// The sender and subject come from the server's own read of the inbox, never from the agent.
export const ProposalItem = z.strictObject({
  id: MailId,
  op: Op,
  folder: z.string().nullable(),
  // Proposals saved before new folders existed have none.
  newFolder: z.boolean().default(false),
  // Read outside the inbox, under no folder (Gmail only).
  outside: z.boolean().default(false),
  reason: z.string(),
  from: z.string(),
  subject: z.string().nullable(),
  result: ItemResult.nullable(),
});
export type ProposalItem = z.infer<typeof ProposalItem>;

export type Proposal = {
  id: number;
  account: MailAccount;
  createdAt: string;
  status: "pending" | "applied" | "discarded";
  items: ProposalItem[];
};

// What the user did with past proposals for one sender, op and folder: how often they kept it
// ticked and it was applied, and how often they unticked it. The categorizer learns from it.
export type Decision = {
  from: string;
  op: z.infer<typeof Op>;
  folder: string | null;
  kept: number;
  skipped: number;
};

// The ids the user kept ticked; the rest are skipped.
export const ApplyBody = z.strictObject({ keep: z.array(MailId).min(1).max(MAX_PROPOSAL) });
