import { createHash } from "node:crypto";
import { join } from "node:path";
import { type MailAccount, SORT_PROMPT, sortPromptId } from "../../../shared/mail-sort.ts";
import { log } from "../../log.ts";
import { MemoryError, type MemoryStore } from "../memory/store.ts";

// The saved prompts «Categorizar» launches from each Inicio column. The agent reads through
// `aos mail` and proposes; the user reviews and applies in Inicio. Paths are absolute: the
// agent starts in the scratch folder.

// The personal account's goal: an inbox holding only what needs the user, everything kept filed,
// and no mail without value. Work mail only moves where the user already files it.
const personalRules = (
  aos: string,
) => `The goal: the inbox holds only what still needs the user; everything worth keeping is filed under a label; mail without value goes to the trash. Decide every mail, in this order:
1. Leave it in the inbox (do not propose it) only when it needs a reply or an action from the user, it is starred, or it is unread and from the last two days.
2. Trash mail without value: advertising, promotions and offers, newsletters, social network notifications, automatic alerts and codes already past (verification, login, shipping of delivered orders, expired reminders), and spam or phishing. The profile's \`trash\` senders and mostly unread PROMOTIONS \`senders\` are clear cases.
3. Never trash mail from someone the user writes to (\`correspondents\`), nor what a person may need later: invoices, receipts, bank, tax, insurance, health, contracts, warranties, bookings and tickets, official letters. File those.
4. File what is kept under the user's label for that sender, domain or kind. When several mails share a kind that no label fits (trips, bank, orders, home, a club), propose a new label: moves with \`"newFolder": true\` to one short Spanish name, the same for all of them.
5. Propose \`"op":"archive"\` (no folder) for inbox mail worth keeping that fits no label and no new one.
Then sort older mail by the same rules: run \`${aos} mail outside personal\`, mail out of the inbox under no label, and again with \`--page <next>\` up to four pages, while the proposal stays under 500 mails. It cannot be archived again: it is filed, trashed, or left where it is. Put everything in the same file.
`;

export function sortPromptBody(account: MailAccount, appRoot: string): string {
  const aos = `"${join(appRoot, "bin", "aos")}"`;
  const work = account === "work";
  const where = work
    ? "every folder with its exact `path`, its `role` and its most frequent senders. Only folders with role null are targets"
    : "the user's labels with their frequent senders, the senders they bin (`trash`), the people they write to (`correspondents`) and each sender's unread share. Labels are targets by their exact `name`";
  return `---
name: ${SORT_PROMPT[account]}
description: ${work ? "Propone dónde va cada correo de la bandeja de Outlook" : "Deja la bandeja de Gmail limpia: ordena lo que vale y tira lo que no"}
bar: false
---
You sort the user's ${work ? "work inbox (Outlook)" : "personal inbox (Gmail)"} by proposing, never by moving. You cannot apply anything: the user reviews your proposal in Inicio and confirms it in a dialog on their Mac.

1. Run \`${aos} mail profile ${account}\`: ${where}.
2. Run \`${aos} mail inbox ${account}\`: the inbox, newest first. Each mail's \`id\` is the one to propose.
3. Run \`${aos} mail decisions ${account}\`: what the user did with your past proposals, by sender (\`from\`, as the inbox shows it), \`op\` and \`folder\`: \`kept\` they applied it, \`skipped\` they unticked it. Never propose again what they unticked twice or more and never kept; follow what they kept.

${
  work
    ? 'Propose a move only when the profile shows clearly where the user files that sender or that kind of mail: the same sender, the same domain, or the same subject pattern already in a folder. Leave a mail in the inbox when unsure, when it may need a reply or an action, when it is flagged, or when it is unread and from today. Do not propose "trash" for work mail.'
    : personalRules(aos)
}
Write the proposal to a JSON file, \`{"items":[{"id":"…","op":"move","folder":"…","reason":"…"}]}\` (a trash${work ? "" : " or an archive"} has no folder), with each reason in Spanish and under 12 words, and send it with \`${aos} mail propose ${account} --input-file <file>\`. If the server lists problems, fix those items and send it again; a new proposal replaces the last one.

Then tell the user, in Spanish, how many mails you proposed for each ${work ? "folder" : "label and for the trash"}, and that they review and apply it in Inicio, column ${work ? "Trabajo" : "Personal"}. Change nothing else.
`;
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const SEEDED = /^seeded: ([0-9a-f]{16})\n/m;

// The prompt as seeded: its front matter names the hash of the rest of its text.
const stamped = (body: string) => body.replace("\n---\n", `\nseeded: ${digest(body)}\n---\n`);

// A seeded prompt whose text still matches its own hash: the user never edited it.
const untouched = (text: string) => {
  const seeded = text.match(SEEDED)?.[1];
  return seeded !== undefined && digest(text.replace(SEEDED, "")) === seeded;
};

// Written when the prompts folder lacks them, and rewritten when this code changes them unless
// the user edited theirs in Docs. Deleting one brings it back on the next start.
export async function seedSortPrompts(
  memory: Pick<MemoryStore, "create" | "get" | "update">,
  appRoot: string,
): Promise<void> {
  for (const account of ["work", "personal"] as const) {
    const body = stamped(sortPromptBody(account, appRoot));
    try {
      await memory.create("prompts", SORT_PROMPT[account], body);
      continue;
    } catch (err) {
      if (!(err instanceof MemoryError) || err.status !== 409) throw err;
    }
    const doc = await memory.get(sortPromptId(account));
    if (doc.body === body) continue;
    if (untouched(doc.body)) await memory.update(doc.id, body, doc.mtime);
    else log("mail").info("kept the user's own sort prompt", { prompt: SORT_PROMPT[account] });
  }
}
