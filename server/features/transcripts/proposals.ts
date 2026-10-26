import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { DAY } from "../../../shared/objectives.ts";
import { readJson, writeJson } from "../../json-file.ts";

// What the agent proposes from a transcript, and what the user decided about each item. Two
// files in the recording's folder: the agent's `proposals.json` (a new one replaces it) and the
// user's `review.json`, keyed by each item's content, so a second run never undoes a decision.

export const ProposalItem = z.strictObject({
  kind: z.enum(["decision", "action", "memory"]),
  text: z.string().trim().min(1).max(400),
  // An action's owner as said in the meeting, and its day when one was said.
  owner: z.string().trim().max(80).nullish(),
  dueOn: z.string().regex(DAY).nullish(),
  // Seconds into the recording where it was said.
  at: z.number().min(0).nullish(),
});
export type ProposalItem = z.infer<typeof ProposalItem>;

export const ProposalBody = z.strictObject({
  summary: z.string().trim().max(1500),
  items: z.array(ProposalItem).max(60),
});
export type ProposalBody = z.infer<typeof ProposalBody>;

const Decision = z.strictObject({
  state: z.enum(["accepted", "discarded"]),
  // The text as the user left it, when they edited it before accepting.
  text: z.string().max(400).optional(),
  at: z.string(),
});
const Review = z.record(z.string(), Decision);
export type Decision = z.infer<typeof Decision>;

export const itemId = (i: ProposalItem) =>
  createHash("sha256").update(`${i.kind}\n${i.text}`).digest("hex").slice(0, 12);

export type Proposals = {
  summary: string;
  items: (ProposalItem & { id: string; decision: Decision | null })[];
};

// The proposals with the user's decisions, or null before the agent sent any.
export function readProposals(dir: string): Proposals | null {
  const body = readJson(join(dir, "proposals.json"), ProposalBody);
  if (!body) return null;
  const review = readJson(join(dir, "review.json"), Review) ?? {};
  return {
    summary: body.summary,
    items: body.items.map((i) => {
      const id = itemId(i);
      return { ...i, id, decision: review[id] ?? null };
    }),
  };
}

export function writeProposals(dir: string, body: ProposalBody) {
  writeJson(join(dir, "proposals.json"), body);
}

export function decide(dir: string, id: string, decision: Decision) {
  const review = readJson(join(dir, "review.json"), Review) ?? {};
  writeJson(join(dir, "review.json"), { ...review, [id]: decision });
}
