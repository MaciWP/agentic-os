import { numbersToDigits } from "./numbers.ts";

// The model writes what it hears; this turns it into what was meant. The model takes no word
// list, so the user's own fixes (`voice.replace`), digits and the Jira key's shape do that job.

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Whole words only: a fix for "hook" leaves "hooks" alone. Letters with accents count as letters.
const word = (s: string) => `(?<![\\p{L}\\p{N}])${s}(?![\\p{L}\\p{N}])`;

export function normalize(
  text: string,
  { replace, jiraProject }: { replace: Record<string, string>; jiraProject?: string },
): string {
  let out = text;
  // Longest first, so "bun run check" wins over a fix for "bun".
  const fixes = Object.entries(replace).sort(([a], [b]) => b.length - a.length);
  for (const [heard, meant] of fixes)
    out = out.replace(new RegExp(word(literal(heard.trim())), "giu"), () => meant);
  out = numbersToDigits(out);
  // "ABC 1077", "abc1077" and "ABC - 1077" are all the key ABC-1077.
  if (jiraProject) {
    const key = jiraProject.toUpperCase();
    out = out.replace(
      new RegExp(`(?<![\\p{L}\\p{N}])${literal(key)}\\s*-?\\s*(\\d+)(?!\\p{N})`, "giu"),
      (_, n: string) => `${key}-${n}`,
    );
  }
  // One line, always: a newline typed into an agent would send the prompt.
  return out.replace(/\s+/g, " ").trim();
}

// The words the model is told to expect: the user's terms, what `replace` turns words into, and
// the Jira key. Once each, ignoring case.
export function glossary({
  terms,
  replace,
  jiraProject,
}: {
  terms: string[];
  replace: Record<string, string>;
  jiraProject?: string;
}): string[] {
  const seen = new Map<string, string>();
  for (const t of [...terms, ...Object.values(replace), jiraProject?.toUpperCase() ?? ""]) {
    const term = t.trim();
    if (term && !seen.has(term.toLowerCase())) seen.set(term.toLowerCase(), term);
  }
  return [...seen.values()];
}
