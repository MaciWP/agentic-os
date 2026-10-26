import { type ReactNode, useEffect, useRef } from "react";
import { minSec } from "../../format.ts";
import { InlineError } from "../../ui.tsx";
import { ENV_ACTION_LABEL } from "../terminals/queries.ts";
import { type JobSummary, useEnvJob } from "./env-jobs.ts";

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="border-b border-line px-4 py-3 last:border-b-0">
      <h3 className="section-title">{title}</h3>
      <div className="mt-2 space-y-2">{children}</div>
    </section>
  );
}

export function Failure({ error }: { error: string | null }) {
  return error ? <InlineError className="text-[12px]">{error}</InlineError> : null;
}

const elapsed = (from: string, to: string | null) => {
  const s = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000));
  return minSec(s);
};

// What a job is doing or how it ended, and everything the provider wrote, newest at the
// bottom and kept in view while it runs. `fill` gives the output all the room its parent has
// (a Mesa tile) instead of a short box.
export function JobOutput({ summary, fill = false }: { summary: JobSummary; fill?: boolean }) {
  const job = useEnvJob(summary.id);
  const shown = job.data?.job ?? { ...summary, output: "", truncated: false };
  const pre = useRef<HTMLPreElement>(null);
  const running = shown.state === "running";
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls when the output grows
  useEffect(() => {
    if (running && pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [shown.output, running]);
  const what = `${ENV_ACTION_LABEL[shown.action]}${shown.env ? ` ${shown.env}` : ""}`;
  return (
    <section
      aria-label={`Resultado: ${what}`}
      className={`text-[12px] ${fill ? "flex min-h-0 flex-1 flex-col gap-1 p-3" : "space-y-1"}`}
    >
      <p className="flex flex-wrap items-center gap-x-2">
        <span className="font-medium">{what}</span>
        {running ? (
          <span className="text-primary">en curso · {elapsed(shown.startedAt, null)}</span>
        ) : shown.state === "ok" ? (
          <span className="text-ok">terminado · {elapsed(shown.startedAt, shown.endedAt)}</span>
        ) : (
          <span className="text-bad">falló: {shown.error ?? "sin motivo"}</span>
        )}
      </p>
      {job.error && <Failure error={`No se pudo leer la salida: ${job.error.message}`} />}
      {shown.truncated && (
        <p className="text-ink-2">La salida es larga: se muestran sus últimos 256 KB.</p>
      )}
      {shown.output ? (
        <pre
          ref={pre}
          className={`${fill ? "min-h-0 flex-1" : "max-h-72"} overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-bg p-2 font-mono text-[11px] leading-[1.45]`}
        >
          {shown.output}
        </pre>
      ) : (
        running && <p className="text-ink-2">Esperando la primera línea del proveedor…</p>
      )}
    </section>
  );
}
