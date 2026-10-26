import type { ReactNode } from "react";
import { ErrorState, SkeletonRows } from "../../ui.tsx";
import { type HeaderDrag, TileHeader } from "../terminals/tile-header.tsx";
import { latestJob, useEnvJobs } from "./env-jobs.ts";
import { JobOutput } from "./job-output.tsx";
import { useProjects } from "./queries.ts";

// An env's commands as a Mesa tile, beside its terminals: what the newest one (Levantar,
// Parar, Actualizar, Borrar) wrote while it ran and how it ended. It opens by itself when one
// starts. Jobs live in the server's memory, so after a restart there is nothing to show; a
// removed env keeps its remove's result here.
export function JobView({
  env,
  lead,
  actions,
  drag,
}: {
  env: string | null;
  lead?: ReactNode;
  actions?: ReactNode;
  drag?: HeaderDrag;
}) {
  const list = useEnvJobs();
  const projects = useProjects();
  const last = env ? latestJob(list.data?.jobs, (j) => j.env === env) : null;
  // A failed provider lists nothing, which says nothing about this env.
  const gone =
    env !== null &&
    projects.data &&
    !projects.data.envs.error &&
    !projects.data.envs.items.some((e) => e.name === env);
  return (
    <div className="flex h-full min-h-0 flex-col bg-panel text-ink">
      <TileHeader
        lead={lead}
        harness="env"
        chip="Entorno"
        label={env ?? "?"}
        title={env ?? ""}
        drag={drag}
      >
        {gone && <span className="shrink-0 text-white/45">ya no está</span>}
        {actions}
      </TileHeader>
      {!env ? (
        <p className="px-4 py-3 text-[12px] text-ink-2">
          Esta tile no dice de qué entorno es: quítala y ábrela otra vez desde el árbol.
        </p>
      ) : list.isPending ? (
        <SkeletonRows count={3} />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : last ? (
        <JobOutput key={last.id} summary={last} fill />
      ) : (
        <p className="px-4 py-3 text-[12px] text-ink-2">
          No hay ninguna acción de {env} desde que arrancó el servidor. Levantar, Parar, Actualizar
          o Borrar muestran aquí lo que escribe el proveedor.
        </p>
      )}
    </div>
  );
}
