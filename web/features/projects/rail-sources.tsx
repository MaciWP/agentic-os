import { useEffect, useState } from "react";
import { z } from "zod";
import { storageKey } from "../../storage.ts";
import { isOff } from "../../ui.tsx";
import { SEGMENT } from "../terminals/mesa-rail.tsx";
import { useProjects } from "./queries.ts";
import { PrsList, TicketsList, usePrRows, useSourceTickets } from "./sources.tsx";
import { ProjectsTree } from "./tree.tsx";

// Under the Mesas in the rail: the places to work and what goes into the terminals, one tab at
// a time, the tab kept in this browser. Tickets and PRs say how many they hold once read.
export const RAIL_SOURCES = ["projects", "tickets", "prs"] as const;
type RailSource = (typeof RAIL_SOURCES)[number];
export const railSource = storageKey("aos.rail.source", {
  schema: z.enum(RAIL_SOURCES),
  fallback: "projects",
});

export function RailSources({ node }: { node?: string }) {
  const [kept, setKept] = useState<RailSource>(railSource.get);
  const show = (next: RailSource) => {
    setKept(next);
    railSource.set(next);
  };
  // A link to a node shows the projects from the first render, and keeps them shown.
  const tab = node ? "projects" : kept;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new node switches the tab
  useEffect(() => {
    if (node) show("projects");
  }, [node]);
  const repos = useProjects().data?.repos.map((r) => r.id) ?? [];
  const tickets = useSourceTickets();
  const prs = usePrRows(repos);
  const counts: Record<RailSource, number | undefined> = {
    projects: undefined,
    tickets: tickets.q.data && !isOff(tickets.q.data) ? tickets.tickets.length : undefined,
    prs: prs.q.data && !isOff(prs.q.data) ? prs.prs.length : undefined,
  };
  const names: Record<RailSource, string> = {
    projects: "Proyectos",
    tickets: "Tickets",
    prs: "PRs",
  };
  return (
    <section aria-label={names[tab]} className="flex min-h-0 flex-col border-line border-t pt-3">
      <fieldset aria-label="Fuentes del carril" className="flex shrink-0 items-center gap-0.5 px-2">
        {RAIL_SOURCES.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={tab === s}
            className={SEGMENT}
            onClick={() => show(s)}
          >
            {names[s]}
            {counts[s] !== undefined && (
              <span className="font-normal text-[11px] text-ink-2 tabular-nums">{counts[s]}</span>
            )}
          </button>
        ))}
      </fieldset>
      <div className="min-h-0 flex-1 overflow-y-auto pt-2">
        {tab === "projects" ? (
          <ProjectsTree selected={{ node }} />
        ) : tab === "tickets" ? (
          <TicketsList />
        ) : (
          <PrsList repos={repos} />
        )}
      </div>
    </section>
  );
}
