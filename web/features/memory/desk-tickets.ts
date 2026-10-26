import { isOff } from "../../ui.tsx";
import type { TicketRow } from "../tickets/groups.ts";
import { useConnections, useTeamTickets, useTickets } from "../tickets/queries.ts";
import { dayKey, NONE } from "./journal.ts";
import { projectsOf, ticketsIn } from "./keys.ts";
import type { DocSummary } from "./queries.ts";

// The user's Jira tickets, to read the keys notes name. With Jira loading, failing or off no key
// is guessed, and the desk says why.
type Jira =
  | { state: "ok" | "loading" | "off" }
  | { state: "error"; error: unknown; retry: () => void };
export type Tk = {
  of: (k: string) => TicketRow | undefined;
  in: (d: Pick<DocSummary, "title" | "description" | "rel">) => string[];
  projects: ReadonlySet<string>;
  jira: Jira;
  // What a key that `of` does not know is: not the user's, or not known yet.
  absent: string;
};

export function useTk(): Tk {
  const mine = useTickets();
  const team = useTeamTickets();
  const mineList = mine.data && !isOff(mine.data) ? mine.data.tickets : [];
  const teamList = team.data && !isOff(team.data) ? team.data.tickets : [];
  // A teammate's ticket shows its status too; the user's own list wins on a repeated key.
  const all = [...teamList, ...mineList];
  const byKey = new Map(all.map((t) => [t.key, t]));
  // The configured project counts before the tickets load and while Jira fails.
  const configured = useConnections().data?.connections.find((c) => c.provider === "atlassian");
  const projects = projectsOf(all);
  if (configured?.project) projects.add(configured.project);
  const jira: Jira = mine.isPending
    ? { state: "loading" }
    : mine.isError
      ? { state: "error", error: mine.error, retry: () => void mine.refresh() }
      : mine.data && isOff(mine.data)
        ? { state: "off" }
        : { state: "ok" };
  // Until both lists are read, a missing key may be a teammate's ticket that did not arrive.
  const absent =
    mine.data && team.data
      ? "no está entre tus tickets"
      : team.isError
        ? "sin datos del equipo en Jira"
        : mine.isError
          ? "sin datos de Jira"
          : "leyendo Jira…";
  return { of: (k) => byKey.get(k), in: (x) => ticketsIn(x, projects), projects, jira, absent };
}

export type Filter = { kind: "day" | "ticket" | "source"; value: string } | null;

export const keysOf = (d: DocSummary, tk: Tk) => {
  const k = tk.in(d);
  return k.length ? k : [NONE];
};

export function matches(d: DocSummary, f: Filter, tk: Tk): boolean {
  if (!f) return true;
  if (f.kind === "day") return dayKey(d.mtime) === f.value;
  if (f.kind === "ticket") return keysOf(d, tk).includes(f.value);
  return d.source === f.value;
}
