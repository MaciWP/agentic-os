// What the dashboard lists. An event carries only the topic: the browser reads the list
// again through its usual typed query, so the API shape has one source.
export const TOPICS = [
  "terminals",
  "tickets",
  "projects",
  "envjobs",
  "coordination",
  "workspace",
  "prs",
  "kickoff",
  // The mail categorizer's proposals (server/features/mail).
  "mail",
  // Gmail and Google Calendar, and Outlook through the Mac: a read past its minute answers the
  // kept copy and says so here when the new one differs (server/cache.ts `onChange`).
  "google",
  "mac",
  // A file to open in the code tile, asked for from outside the page (server/features/code/reveal.ts).
  "reveal",
] as const;
export type Topic = (typeof TOPICS)[number];
