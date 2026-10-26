import { isOff } from "../../ui.tsx";
import { ReviewButton } from "../prs/panel.tsx";
import { useTickets } from "../tickets/queries.ts";
import { type Case, verb } from "./cases.tsx";
import { useInboxData } from "./data.ts";
import { Lanes } from "./lanes.tsx";
import { ItemAction } from "./parts.tsx";

// Each case ends in the navigation its item has: the Mesa, Agentes, GitHub or the ticket. A PR
// also keeps "Revisar", which starts a review agent from a saved prompt; "Abrir" is GitHub.
export function Action({ c, className = "btn-ghost text-ink" }: { c: Case; className?: string }) {
  if (c.item.kind !== "pr")
    return <ItemAction item={c.item} className={className} label={verb(c)} />;
  return (
    <span className="flex shrink-0 items-center gap-1">
      <ReviewButton pr={c.item.pr} className={className} />
      <ItemAction item={c.item} className={className} label="Abrir" />
    </span>
  );
}

// The day's tickets as lanes, opened in Inicio's centre from «Hoy».
export function TicketLanes() {
  const data = useInboxData();
  const tickets = useTickets();
  const rows = tickets.data && !isOff(tickets.data) ? tickets.data.tickets : [];
  return <Lanes data={data} tickets={rows} Action={Action} />;
}
