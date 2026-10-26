import { useState } from "react";
import { Consultation, type Participant } from "../../../shared/coordination.ts";
import { HARNESS_CAPABILITIES } from "../../../shared/harness-capabilities.ts";
import { ErrorState, InlineError, SkeletonRows } from "../../ui.tsx";
import { HARNESS_LABEL, useTerminals } from "../terminals/queries.ts";
import {
  field,
  STATE,
  type Summary,
  useCapabilities,
  useConsultation,
  useCoordAction,
} from "./queries.ts";

export function Consultations({ data }: { data: Summary }) {
  const [selected, select] = useState("");
  const [creating, create] = useState(false);
  const active = selected || data.consultations[0]?.id || "";
  return (
    <div className="grid min-h-0 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <section aria-label="Consultas" className="min-w-0">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="font-semibold">Consultas</h2>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => create(!creating)}
            aria-expanded={creating}
          >
            Nueva consulta
          </button>
        </div>
        <p className="mb-3 text-[12px] text-ink-2">
          Opiniones independientes sobre la misma captura del código. Cada lote necesita tu
          aprobación.
        </p>
        {data.consultations.length === 0 && <p className="text-ink-2">Todavía no hay consultas.</p>}
        <ul className="space-y-1">
          {data.consultations.map((q) => (
            <li key={q.id}>
              <button
                type="button"
                className={`w-full rounded-md border border-line px-3 py-2 text-left hover:bg-hover ${q.id === active ? "bg-selected" : ""}`}
                aria-pressed={q.id === active}
                onClick={() => {
                  select(q.id);
                  create(false);
                }}
              >
                <span className="block break-words font-medium">{q.prompt}</span>
                <span className="text-[12px] text-ink-2">
                  {STATE[q.state]} · {q.attempts.length} respuestas
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section
        aria-label={creating ? "Preparar consulta" : "Detalle de consulta"}
        className="min-w-0"
      >
        {creating ? (
          <NewConsultation
            onPrepared={(id) => {
              select(id);
              create(false);
            }}
          />
        ) : active ? (
          <ConsultationDetail key={active} id={active} onDeleted={() => select("")} />
        ) : null}
      </section>
    </div>
  );
}
function NewConsultation({ onPrepared }: { onPrepared: (id: string) => void }) {
  const caps = useCapabilities(),
    terminals = useTerminals(),
    action = useCoordAction();
  const [models, setModels] = useState<Record<string, string>>({});
  const [efforts, setEfforts] = useState<Record<string, string>>({});
  const locations = terminals.data?.locations ?? [];
  return (
    <form
      className="space-y-4 rounded-md border border-line p-4"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const participants = (caps.data?.adapters ?? [])
          .filter((a) => a.available && models[a.harness]?.trim())
          .map((a) => ({
            harness: a.harness,
            model: models[a.harness]?.trim(),
            ...(efforts[a.harness] && { effort: efforts[a.harness] }),
          }));
        action.mutate(
          {
            path: "/consultations",
            body: {
              requestId: crypto.randomUUID(),
              location: form.get("location"),
              prompt: form.get("prompt"),
              context: form.get("context"),
              participants,
              timeoutMs: Number(form.get("minutes")) * 60_000,
            },
          },
          { onSuccess: (value) => onPrepared(Consultation.parse(value).id) },
        );
      }}
    >
      <h2 className="font-semibold">Preparar consulta</h2>
      <label className="block">
        Proyecto
        <select name="location" required className={`${field} mt-1`}>
          <option value="">Selecciona un proyecto</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        Pregunta
        <textarea name="prompt" required rows={4} maxLength={12000} className={`${field} mt-1`} />
      </label>
      <label className="block">
        Contexto adicional
        <textarea name="context" rows={2} maxLength={32000} className={`${field} mt-1`} />
      </label>
      {caps.isPending && <SkeletonRows count={2} />}
      {caps.isError && <ErrorState error={caps.error} onRetry={() => caps.refetch()} />}
      <fieldset className="space-y-3">
        <legend className="mb-2 font-medium">Modelos · elige al menos dos arneses</legend>
        {caps.data?.adapters.map((a) => (
          <div key={a.harness} className="grid gap-2 sm:grid-cols-2">
            <label>
              {HARNESS_LABEL[a.harness]}
              <input
                aria-label={`Modelo de ${HARNESS_LABEL[a.harness]}`}
                className={`${field} mt-1`}
                disabled={!a.available}
                value={models[a.harness] ?? ""}
                onChange={(e) => setModels({ ...models, [a.harness]: e.target.value })}
                placeholder="Identificador del modelo"
              />
            </label>
            <label>
              Esfuerzo
              <select
                className={`${field} mt-1`}
                aria-label={`Esfuerzo de ${HARNESS_LABEL[a.harness]}`}
                disabled={!a.available}
                value={efforts[a.harness] ?? ""}
                onChange={(e) => setEfforts({ ...efforts, [a.harness]: e.target.value })}
              >
                <option value="">Predeterminado del modelo</option>
                {HARNESS_CAPABILITIES[a.harness].consultation.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </label>
            {!a.available && (
              <p className="text-[12px] text-warn sm:col-span-2">
                {a.harness === "grok"
                  ? "Grok no está disponible para consultas: falta verificar su salida y aislamiento de solo lectura."
                  : a.reason}
              </p>
            )}
          </div>
        ))}
      </fieldset>
      <label className="block">
        Minutos por respuesta
        <input
          name="minutes"
          type="number"
          min={1}
          max={60}
          defaultValue={10}
          required
          className={`${field} mt-1`}
        />
      </label>
      <p className="text-[12px] text-ink-2">
        Se guardarán los cambios locales y los ficheros no ignorados. Podrás revisar el lote antes
        de lanzarlo. No hay reintentos automáticos.
      </p>
      {action.isError && <ErrorState error={action.error} />}
      <button
        type="submit"
        className="btn btn-primary"
        disabled={action.isPending || Object.values(models).filter((m) => m.trim()).length < 2}
      >
        {action.isPending ? "Capturando código…" : "Preparar lote"}
      </button>
    </form>
  );
}
function ConsultationDetail({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const query = useConsultation(id),
    action = useCoordAction();
  const [synthesis, setSynthesis] = useState(false);
  if (query.isPending) return <SkeletonRows />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const q = query.data,
    queued = q.attempts.filter((a) => a.state === "queued");
  const closed = ["finished", "cancelled", "failed"].includes(q.state);
  return (
    <div className="space-y-4">
      <div className="rounded-md border border-line p-4">
        <h2 className="whitespace-pre-wrap break-words font-semibold">{q.input.prompt}</h2>
        <p className="mt-2 text-[12px] text-ink-2">
          {STATE[q.state]} · {q.input.location} · {q.input.timeoutMs / 60_000} min por respuesta
        </p>
        {q.fingerprint && (
          <p className="mt-1 break-all font-mono text-[11px] text-ink-2" title={q.fingerprint}>
            Captura: {q.fingerprint}
          </p>
        )}
        {q.contextText && (
          <details className="mt-3">
            <summary className="cursor-pointer">Contexto del lote</summary>
            <pre className="mt-2 whitespace-pre-wrap break-words text-[12px]">{q.contextText}</pre>
          </details>
        )}
        {q.error && <InlineError className="mt-2">{q.error}</InlineError>}
        {queued.length > 0 && (
          <ul className="my-3 space-y-1">
            {queued.map((a) => (
              <li key={a.id}>
                {HARNESS_LABEL[a.participant.harness]} · <strong>{a.participant.model}</strong> ·{" "}
                {a.participant.effort ?? "esfuerzo predeterminado"}
                {a.kind === "synthesis" ? " · síntesis" : ""}
              </li>
            ))}
          </ul>
        )}
        {q.state === "approved" && (
          <p role="status" className="mt-2 text-warn">
            Aprobada; el inicio todavía no está confirmado. Comprueba el estado antes de crear otra
            consulta.
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {q.state === "approved" && (
            <button
              type="button"
              className="btn"
              disabled={action.isPending}
              onClick={() => action.mutate({ path: `/consultations/${id}/start` })}
            >
              Reintentar inicio aprobado
            </button>
          )}
          {q.state === "pending" && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={action.isPending}
              onClick={() =>
                action.mutate({
                  path: `/consultations/${id}/approve`,
                  body: { fingerprint: q.fingerprint, attempts: queued.map((a) => a.id) },
                })
              }
            >
              Aprobar y lanzar {queued.length} {queued.length === 1 ? "respuesta" : "respuestas"}
            </button>
          )}
          {!closed && (
            <button
              type="button"
              className="btn"
              disabled={action.isPending}
              onClick={() => action.mutate({ path: `/consultations/${id}/cancel` })}
            >
              Cancelar consulta
            </button>
          )}
          {closed && q.attempts.some((a) => a.kind === "opinion" && a.state === "succeeded") && (
            <button
              type="button"
              className="btn"
              onClick={() => setSynthesis(!synthesis)}
              aria-expanded={synthesis}
            >
              Preparar síntesis
            </button>
          )}
          {closed && (
            <button
              type="button"
              className="btn"
              disabled={action.isPending}
              onClick={() => {
                if (window.confirm("¿Borrar esta consulta, sus respuestas y la captura local?"))
                  action.mutate(
                    { path: `/consultations/${id}`, method: "DELETE", body: { confirm: id } },
                    { onSuccess: onDeleted },
                  );
              }}
            >
              Borrar consulta
            </button>
          )}
        </div>
      </div>
      {synthesis && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const participant = { harness: f.get("harness"), model: f.get("model") } as Participant;
            action.mutate(
              { path: `/consultations/${id}/followup`, body: { kind: "synthesis", participant } },
              { onSuccess: () => setSynthesis(false) },
            );
          }}
        >
          <label>
            Arnés
            <select name="harness" className={field}>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
          </label>
          <label>
            Modelo
            <input name="model" required className={field} />
          </label>
          <button type="submit" className="btn" disabled={action.isPending}>
            Preparar síntesis para aprobar
          </button>
        </form>
      )}
      {q.snapshotInfo && (
        <p className="mt-2 text-[12px] text-ink-2">
          {q.snapshotInfo.files} ficheros · {Math.ceil(q.snapshotInfo.bytes / 1024)} KiB · revisión{" "}
          {q.snapshotInfo.head}
        </p>
      )}
      {Boolean(q.snapshotInfo?.excluded.length) && (
        <details className="mt-2 text-warn">
          <summary>Enlaces excluidos de la captura ({q.snapshotInfo?.excluded.length})</summary>
          <ul>
            {q.snapshotInfo?.excluded.map((path) => (
              <li key={path} className="break-all">
                {path}
              </li>
            ))}
          </ul>
        </details>
      )}
      {action.isError && <ErrorState error={action.error} />}
      <div className="grid gap-3 xl:grid-cols-2">
        {q.attempts.map((a) => (
          <article key={a.id} className="min-w-0 rounded-md border border-line p-4">
            <h3 className="font-semibold">
              {HARNESS_LABEL[a.participant.harness]} · {a.participant.model}
              {a.kind === "synthesis" ? " · Síntesis" : ""}
            </h3>
            <p className="mt-1 text-[12px] text-ink-2">{STATE[a.state]}</p>
            {a.result && (
              <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-[13px]">
                {a.result}
              </pre>
            )}
            {a.error && <p className="mt-2 break-words text-bad">{a.error}</p>}
            {a.usage && (
              <details className="mt-2 text-[12px] text-ink-2">
                <summary>Consumo registrado</summary>
                <pre className="whitespace-pre-wrap">{JSON.stringify(a.usage, null, 2)}</pre>
              </details>
            )}
            {closed && ["failed", "timed_out", "interrupted", "cancelled"].includes(a.state) && (
              <button
                type="button"
                className="btn mt-3"
                disabled={action.isPending}
                onClick={() =>
                  action.mutate({
                    path: `/consultations/${id}/followup`,
                    body: { kind: "retry", attempt: a.id },
                  })
                }
              >
                Preparar reintento
              </button>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
