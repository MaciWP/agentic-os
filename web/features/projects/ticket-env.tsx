import { ticketBranch } from "../../../shared/envs.ts";
import { InlineError } from "../../ui.tsx";
import { createEnv, runEnv, useLaunch, useTerminals } from "../terminals/queries.ts";
import { EnvBadge } from "./env-badge.tsx";
import { envState, groupTerminals, ticketEnv, useProjects } from "./queries.ts";

// A ticket's env in one click: its state and "Levantar" when it exists, "Crear entorno" with
// every repo of the profile when it does not. Each runs in a visible tile, where the provider
// asks what it needs.
export function TicketEnv({ ticket }: { ticket: string }) {
  const projects = useProjects();
  const terminals = useTerminals().data?.terminals ?? [];
  const run = useLaunch();
  const p = projects.data;
  if (!p?.envs.configured) return null;
  const found = ticketEnv(p, ticket);
  if (found === "unknown")
    return (
      <InlineError className="pt-0.5 text-[11px]">
        No se pudieron leer los entornos: {p.envs.error}
      </InlineError>
    );
  const env = found;
  const name = ticket.toLowerCase();
  const here = groupTerminals(terminals, p).byNode;
  // A create still running shows under the envs node until the provider lists the env.
  const creating = terminals.some(
    (t) => t.state === "running" && t.action === "create" && t.env === name,
  );
  const state = env ? envState(env.repos, here.get(`env:${env.name}`)) : creating ? "busy" : null;
  return (
    <div className="flex flex-wrap items-center gap-x-1 pt-0.5 text-[11px]">
      {env && <span className="font-mono text-ink-2">{env.name}</span>}
      {state && <EnvBadge state={state} detail={env?.repos.map((r) => r.repo).join(", ") ?? ""} />}
      {env && state !== "up" && state !== "busy" && (
        <button
          type="button"
          className="btn-ghost"
          disabled={run.pending || Boolean(env.problem)}
          aria-label={`Levantar el entorno de ${ticket}`}
          onClick={() => run.launch(() => runEnv("start", env.name))}
        >
          Levantar
        </button>
      )}
      {!env && !creating && (
        <button
          type="button"
          className="btn-ghost"
          disabled={run.pending || p.envs.repos.length === 0}
          aria-label={`Crear el entorno de ${ticket}`}
          title={`Crea ${name} con ${p.envs.repos.join(", ")} en la rama ${ticketBranch(ticket)}`}
          onClick={() => run.launch(() => createEnv(name, p.envs.repos, ticket))}
        >
          Crear entorno
        </button>
      )}
      {run.error && (
        <InlineError as="span" className="basis-full">
          {run.error}
        </InlineError>
      )}
    </div>
  );
}
