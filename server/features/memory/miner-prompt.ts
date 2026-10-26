import { join } from "node:path";
import { MemoryError, type MemoryStore } from "./store.ts";

export const MINER_PROMPT = "Minar rituales";

// The saved prompt that turns what the user types again and again into work bar drafts. Paths
// are absolute: it is dropped on agents working in any folder. It names the bar's variables
// without writing them, or the drop would fill them in.
export function minerBody(appRoot: string, dataDir: string): string {
  const script = join(appRoot, "scripts", "mine-rituals.ts");
  const prompts = join(dataDir, "prompts");
  return `---
name: ${MINER_PROMPT}
description: Propone botones para la barra a partir de lo que escribes a menudo
bar: true
---
Run \`bun "${script}"\` and read its JSON. \`rituals\` are prompts the user typed the same way at least three times; \`candidates\` are the rest of their recent or repeated prompts, with tickets, paths, URLs and numbers taken out as placeholders such as {{path}}, {{url}} and {{n}}.

Group the rituals and candidates by meaning, not wording: the same request phrased differently is one group. Skip one-off requests, replies to a question ("sí", "sigue", "hecho"), test or benchmark prompts and anything only meaningful in its conversation.

Write up to 8 drafts, the groups that repeat most, each as a Markdown file in "${prompts}" with this frontmatter and the prompt as its body:

---
name: <short Spanish name, the button's text>
bar: false
source: miner
seen: <how many prompts the group covers>
---

The body is a reusable instruction in the user's own voice and language. Where the run named a ticket, the objective, the branch, the folder or the location, write the variable ticket, objective, branch, cwd or location between double curly braces, as the script writes {{path}}; the work bar fills those when the button is dropped. Never overwrite an existing file.

Then report each draft's name and the candidates it covers, so the user can turn on the useful ones with «En la barra» in Docs. Change nothing else.
`;
}

// Written once when the prompts folder lacks it. Taking it off the bar keeps it; deleting it
// brings it back on the next start, as a kickoff recipe does.
export async function seedMiner(
  memory: Pick<MemoryStore, "create">,
  appRoot: string,
  dataDir: string,
): Promise<void> {
  try {
    await memory.create("prompts", MINER_PROMPT, minerBody(appRoot, dataDir));
  } catch (err) {
    if (!(err instanceof MemoryError) || err.status !== 409) throw err;
  }
}
