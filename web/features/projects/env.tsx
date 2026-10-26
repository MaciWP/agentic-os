import { useState } from "react";
import { Icon } from "../../icons.tsx";
import { Modal } from "../../ui.tsx";
import { EnvBadge } from "./env-badge.tsx";
import { latestJob, useEnvJobs, useEnvStatus, useStartJob } from "./env-jobs.ts";
import { NewEnvForm } from "./env-new.tsx";
import { Failure, JobOutput, Section } from "./job-output.tsx";
import { envState, type Projects } from "./queries.ts";

// The env commands run by the server without a terminal (ADR 0005): the panel shows what the
// provider writes while it runs, then the result. Only the logs, which never end, open a
// terminal.

// The services every env shares, the proxy, and each env's servers, side by side.
function EnvStatus({ envs }: { envs: Projects["envs"] }) {
  const status = useEnvStatus();
  const s = status.data?.configured ? status.data : null;
  return (
    <div className="space-y-2 text-[12px]">
      {status.isError && <Failure error={`No se pudo leer el estado: ${status.error.message}`} />}
      {status.isPending && <p className="text-ink-2">Leyendo el estado…</p>}
      {s && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-ink-2">Servicios compartidos</dt>
          <dd>
            {s.shared.error ? (
              <span className="text-bad">{s.shared.error}</span>
            ) : s.shared.value && s.shared.value.running > 0 ? (
              <span className="text-ok">
                {s.shared.value.running} en marcha
                {s.shared.value.envs.length > 0 && (
                  <span className="text-ink-2"> · los usan {s.shared.value.envs.join(", ")}</span>
                )}
              </span>
            ) : (
              <span className="text-ink-2">parados</span>
            )}
          </dd>
          <dt className="text-ink-2">Proxy HTTPS</dt>
          <dd>
            {s.proxy.error ? (
              <span className="text-bad">{s.proxy.error}</span>
            ) : s.proxy.value?.up ? (
              <span className="text-ok">activo · {s.proxy.value.hosts.length} direcciones</span>
            ) : (
              <span className="text-ink-2">parado</span>
            )}
          </dd>
        </dl>
      )}
      {envs.error ? (
        <Failure error={`No se pudo leer los entornos: ${envs.error}`} />
      ) : envs.items.length === 0 ? (
        <p className="text-ink-2">Ningún entorno todavía.</p>
      ) : (
        <ul className="space-y-1">
          {envs.items.map((e) => (
            <li key={e.name} className="flex items-center gap-2">
              <span className="font-mono">{e.name}</span>
              <EnvBadge
                state={envState(e.repos)}
                detail={e.repos.map((r) => `${r.repo} · ${r.servers ?? "—"}`).join("\n")}
              />
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="btn-ghost"
        disabled={status.isFetching}
        onClick={() => void status.refetch()}
      >
        {status.isFetching ? "Actualizando…" : "Actualizar estado"}
      </button>
    </div>
  );
}

type Jobs = ReturnType<typeof useStartJob>;

// The "Nuevo entorno" modal: the form, and the last create's progress or result.
export function NewEnvBody({ envs, jobs }: { envs: Projects["envs"]; jobs: Jobs }) {
  const list = useEnvJobs();
  const created = latestJob(list.data?.jobs, (j) => j.action === "create");
  return (
    <div className="space-y-2 px-4 py-3">
      <NewEnvForm repos={envs.repos} taken={envs.items.map((e) => e.name)} jobs={jobs} />
      <Failure error={jobs.error} />
      {created && <JobOutput summary={created} />}
    </div>
  );
}

// The "Diagnóstico" modal: the state of every env and of what they share, and the check-up.
export function CheckBody({ envs, check }: { envs: Projects["envs"]; check: Jobs }) {
  const list = useEnvJobs();
  const doctor = latestJob(list.data?.jobs, (j) => j.action === "doctor");
  return (
    <>
      <Section title="Estado general">
        <EnvStatus envs={envs} />
      </Section>
      <Section title="Revisión">
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <button
            type="button"
            className="btn"
            disabled={check.pending || doctor?.state === "running"}
            onClick={() => void check.start({ action: "doctor" })}
          >
            Revisar
          </button>
          <span className="text-ink-2">Docker, herramientas, repos y ficheros .env</span>
        </div>
        <Failure error={check.error} />
        {doctor && <JobOutput summary={doctor} />}
      </Section>
    </>
  );
}

// The Entornos header's own buttons: "Nuevo entorno" and "Diagnóstico", each opening its modal.
// The jobs live here, not in the modal, so closing it never loses an error; a create still
// running shows on its button.
export function EnvsActions({ envs }: { envs: Projects["envs"] }) {
  const [open, setOpen] = useState<"new" | "check" | null>(null);
  const jobs = useStartJob();
  const check = useStartJob();
  const list = useEnvJobs();
  const creating = latestJob(list.data?.jobs, (j) => j.action === "create")?.state === "running";
  const close = () => setOpen(null);
  const newLabel = creating ? "Nuevo entorno (se está creando uno)" : "Nuevo entorno";
  return (
    <span className="flex items-center gap-0.5">
      <button
        type="button"
        className="btn-ghost gap-1"
        aria-label={newLabel}
        title={newLabel}
        onClick={() => setOpen("new")}
      >
        <Icon name="plus" size={14} />
        Nuevo
        {creating && (
          <span
            aria-hidden
            className="size-1.5 rounded-full bg-primary motion-safe:animate-attention"
          />
        )}
      </button>
      <button
        type="button"
        className="btn-ghost"
        aria-label="Diagnóstico"
        title="Diagnóstico: servicios compartidos, proxy y revisión"
        onClick={() => setOpen("check")}
      >
        <Icon name="doctor" size={14} />
      </button>
      {open === "new" && (
        <Modal title="Nuevo entorno" onClose={close}>
          <NewEnvBody envs={envs} jobs={jobs} />
        </Modal>
      )}
      {open === "check" && (
        <Modal title="Diagnóstico" onClose={close}>
          <CheckBody envs={envs} check={check} />
        </Modal>
      )}
    </span>
  );
}
