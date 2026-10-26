import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { Pr } from "../../../server/features/github/prs.ts";
import type { Kickoff, KickoffStep } from "../../../server/features/kickoff/run.ts";
import { api, mutate, unwrap } from "../../api.ts";
import { errorText, InlineError } from "../../ui.tsx";
import { useEnvJobs } from "../projects/env-jobs.ts";
import { JobOutput } from "../projects/job-output.tsx";
import { mesaSearch } from "../terminals/mesas.ts";

export type { Kickoff };

// Read again when the server pushes "kickoff" (web/events.ts), never polled.
export function useKickoffs() {
  return useQuery({
    queryKey: ["kickoff"],
    queryFn: async () => unwrap(await api.api.kickoff.$get()),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

const STEP: Record<KickoffStep, string> = {
  context: "reuniendo el contexto",
  env: "preparando el entorno",
  branch: "comprobando las ramas de las PRs",
  services: "levantando los servicios",
  agent: "lanzando Claude",
  jira: "moviendo el ticket en Jira",
};

// What the ticket's kickoff is doing or how it ended, in one line.
export function kickoffText(k: Kickoff): string {
  if (k.state === "running") return `${STEP[k.step]}…`;
  if (k.state === "failed") return `Falló ${STEP[k.step]}: ${k.error}`;
  if (!k.reused) return "Claude está en marcha.";
  if (k.mode === "start") return "Claude ya trabajaba en este ticket.";
  return k.sent
    ? "Le he pasado a Claude lo nuevo de las PRs."
    : "Nada nuevo en las PRs desde la última ronda.";
}

const WHAT = {
  start: {
    label: "Empezar",
    help: "Crea o reutiliza el entorno en feature/{key}, levanta los servicios y abre Claude en modo plan con todo el contexto. Si el ticket está por hacer, lo pasa a en curso, y si no tiene a nadie, te lo asigna.",
  },
  review: {
    label: "Revisar a fondo",
    help: "Crea o reutiliza un entorno en las ramas de las PRs, levanta los servicios y abre Claude con las skills de revisión. Deja una review pendiente en GitHub: la envías tú. Si su Claude sigue abierto, solo le pasa lo nuevo de las PRs.",
  },
} as const;

// «Empezar» (the user's ticket) or «Revisar a fondo» (a teammate's PRs): one click, the chain
// runs on the server and its steps show here. When it ends while this panel is still open, the
// Mesa shows Claude; elsewhere the user keeps browsing. `pulls` are the PRs offered for review,
// all of them checked.
export function KickoffButton({
  ticketKey,
  mode,
  pulls = [],
}: {
  ticketKey: string;
  mode: "start" | "review";
  pulls?: Pr[];
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const kickoffs = useKickoffs();
  const jobs = useEnvJobs();
  const [unchecked, setUnchecked] = useState<string[]>([]);
  const id = (p: Pr) => `${p.repo}#${p.number}`;
  const chosen = pulls.filter((p) => !unchecked.includes(id(p)));
  const start = useMutation({
    mutationFn: () =>
      mutate<{ kickoff: Kickoff }>("/api/kickoff", "POST", {
        key: ticketKey,
        mode,
        ...(mode === "review" && { prs: chosen.map((p) => ({ repo: p.repo, number: p.number })) }),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["kickoff"] }),
  });
  const k = kickoffs.data?.kickoffs.find((x) => x.key === ticketKey && x.mode === mode);
  const clicked = start.data?.kickoff.startedAt;
  useEffect(() => {
    if (k && clicked && k.startedAt === clicked && k.state === "ok" && k.terminal)
      void navigate({ to: "/terminales", search: mesaSearch({ t: k.terminal }) });
  }, [k, clicked, navigate]);
  const running = k?.state === "running";
  const job = k?.job ? jobs.data?.jobs.find((j) => j.id === k.job) : undefined;
  const showJob = job && (running || k?.state === "failed") && k?.step !== "agent";

  return (
    <div className="flex flex-col gap-2 text-[12px]">
      {pulls.length > 1 && (
        <fieldset className="flex flex-col gap-1">
          <legend className="text-ink-2">PRs que revisa</legend>
          {pulls.map((p) => (
            <label key={id(p)} className="flex items-center gap-1.5 font-mono">
              <input
                type="checkbox"
                checked={!unchecked.includes(id(p))}
                onChange={(e) =>
                  setUnchecked((now) =>
                    e.target.checked ? now.filter((x) => x !== id(p)) : [...now, id(p)],
                  )
                }
              />
              {id(p)}
            </label>
          ))}
        </fieldset>
      )}
      <button
        type="button"
        className="btn btn-primary self-start"
        disabled={running || start.isPending || (mode === "review" && chosen.length === 0)}
        onClick={() => start.mutate()}
      >
        {WHAT[mode].label}
      </button>
      <p className="text-[11px] text-ink-2">{WHAT[mode].help.replace("{key}", ticketKey)}</p>
      {start.error && <InlineError>{errorText(start.error)}</InlineError>}
      {kickoffs.error && (
        <InlineError>No se pudo leer el arranque: {errorText(kickoffs.error)}</InlineError>
      )}
      {k && (
        <p
          role={k.state === "failed" ? "alert" : "status"}
          className={k.state === "failed" ? "text-bad" : running ? "text-primary" : "text-ok"}
        >
          {kickoffText(k)}{" "}
          {k.terminal && (
            <Link to="/terminales" search={mesaSearch({ t: k.terminal })} className="underline">
              Abrir en la Mesa
            </Link>
          )}
        </p>
      )}
      {k?.warning && <p className="text-warn">{k.warning}</p>}
      {showJob && <JobOutput summary={job} />}
    </div>
  );
}
