import type { DocSummary } from "./queries.ts";

// Ticket keys a document names in its title, description or path. A note has no ticket field,
// so the key is read from those. Only keys from the user's Jira projects count: "NOTA-0" or
// "CLI-2026" are file names, and with no project known (Jira loading, failing or off) no key is
// guessed. Without `projects` at all (the demos' fixtures) any key counts.
export function ticketsIn(
  d: Pick<DocSummary, "title" | "description" | "rel">,
  projects?: ReadonlySet<string>,
): string[] {
  const text = `${d.title} ${d.description ?? ""} ${d.rel}`;
  return [
    ...new Set(
      [...text.matchAll(/\b([A-Za-z][A-Za-z0-9]+-\d+)\b/g)].map((m) => (m[1] ?? "").toUpperCase()),
    ),
  ].filter((k) => !projects || projects.has(k.slice(0, k.lastIndexOf("-"))));
}

// The Jira projects the user's tickets belong to.
export const projectsOf = (tickets: { key: string }[]) =>
  new Set(tickets.map((t) => t.key.slice(0, t.key.lastIndexOf("-"))));
