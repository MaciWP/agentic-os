import { useState } from "react";
import { PageBar } from "../../page-bar.tsx";
import { ErrorState, SkeletonRows } from "../../ui.tsx";
import { HARNESS_LABEL, useTerminals } from "../terminals/queries.ts";
import { Consultations } from "./consultations.tsx";
import {
  field,
  STATE,
  type Summary,
  useCoordAction,
  useCoordination,
  useMessage,
} from "./queries.ts";

export type CoordinationSection = "consultas" | "mensajes" | "reservas";
export function CoordinationPage({
  section,
  agent,
}: {
  section: CoordinationSection;
  agent?: string;
}) {
  const query = useCoordination();
  return (
    <>
      <PageBar>
        <h1 className="font-semibold">Agentes</h1>
        <span className="text-[12px] text-ink-2">Coordinación</span>
      </PageBar>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {query.isPending ? (
          <SkeletonRows />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : section === "consultas" ? (
          <Consultations data={query.data} />
        ) : section === "mensajes" ? (
          <Messages data={query.data} agent={agent} />
        ) : (
          <Reservations data={query.data} agent={agent} />
        )}
      </div>
    </>
  );
}
function Messages({ data, agent }: { data: Summary; agent?: string }) {
  const action = useCoordAction();
  const [selected, select] = useState("");
  const [recipient, setRecipient] = useState(agent ?? "");
  const full = useMessage(selected);
  const list = data.messages.filter((m) => !agent || m.from === agent || m.to === agent);
  const name = (id: string) =>
    id === "user" ? "Tú" : (data.agents.find((a) => a.id === id)?.name ?? id);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(300px,1fr)]">
      <section className="min-w-0">
        <h2 className="mb-2 font-semibold">Mensajes{agent ? ` · ${name(agent)}` : ""}</h2>
        <p className="mb-4 text-[12px] text-ink-2">
          Entregado significa escrito en la terminal. Con respuesta indica que hay una respuesta
          registrada. Una entrega incierta requiere revisión manual.
        </p>
        {list.length === 0 && <p className="text-ink-2">Todavía no hay mensajes.</p>}
        <ul className="space-y-2">
          {list.map((m) => (
            <li key={m.id} className="rounded-md border border-line p-3">
              <button
                type="button"
                className="w-full text-left"
                aria-pressed={selected === m.id}
                onClick={() => select(m.id)}
              >
                <span className="block break-all text-[12px] text-ink-2">
                  {name(m.from)} → {name(m.to)} · {STATE[m.status]}
                </span>
                <span className="mt-1 block whitespace-pre-wrap break-words">{m.preview}</span>
                <span className="mt-1 block text-[11px] text-ink-2">
                  {new Date(m.createdAt).toLocaleString("es-ES")}
                  {m.replyTo ? " · respuesta" : ""}
                </span>
              </button>
              {m.error && <p className="mt-1 text-bad">{m.error}</p>}
            </li>
          ))}
        </ul>
      </section>
      <section className="min-w-0 space-y-4" aria-label="Enviar mensaje">
        {selected && (
          <div className="rounded-md border border-line p-3">
            {full.isPending ? (
              <SkeletonRows count={2} />
            ) : full.isError ? (
              <ErrorState error={full.error} />
            ) : (
              <>
                <h3 className="font-medium">Mensaje completo</h3>
                <pre className="mt-2 whitespace-pre-wrap break-words font-sans">
                  {full.data.text}
                </pre>
                <p className="mt-2 break-all text-[11px] text-ink-2">Hilo: {full.data.threadId}</p>
                {full.data.to === "user" && (
                  <button
                    type="button"
                    className="btn mt-2"
                    onClick={() => setRecipient(full.data.from)}
                  >
                    Responder al remitente
                  </button>
                )}
              </>
            )}
          </div>
        )}
        <form
          className="space-y-3 rounded-md border border-line p-4"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const text = String(new FormData(form).get("text") ?? "");
            const replyTo =
              full.data?.to === "user" && full.data.from === recipient ? full.data.id : undefined;
            action.mutate(
              {
                path: "/messages",
                body: { requestId: crypto.randomUUID(), to: recipient, text, replyTo },
              },
              { onSuccess: () => form.reset() },
            );
          }}
        >
          <h3 className="font-semibold">Enviar mensaje</h3>
          <label className="block">
            Destinatario
            <select
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              required
              className={`${field} mt-1`}
            >
              <option value="">Selecciona un arnés</option>
              {data.agents
                .filter((a) => a.state === "running")
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name ?? HARNESS_LABEL[a.harness as keyof typeof HARNESS_LABEL]} ·{" "}
                    {a.location} · {a.id.slice(0, 8)}
                  </option>
                ))}
            </select>
          </label>
          <label className="block">
            Mensaje
            <textarea name="text" required maxLength={12000} rows={5} className={`${field} mt-1`} />
          </label>
          <p className="text-[12px] text-ink-2">
            Se pegará y enviará directamente al arnés. No interrumpe la sesión.
          </p>
          {action.isError && <ErrorState error={action.error} />}
          <button
            type="submit"
            className="btn btn-primary"
            disabled={action.isPending || !recipient}
          >
            Enviar
          </button>
        </form>
      </section>
    </div>
  );
}
function Reservations({ data, agent }: { data: Summary; agent?: string }) {
  const action = useCoordAction(),
    terminals = useTerminals();
  const list = data.reservations.filter((r) => !agent || r.owner === agent);
  return (
    <div className="max-w-5xl space-y-4">
      <h2 className="font-semibold">Reservas de ficheros</h2>
      <p className="text-[12px] text-ink-2">
        Las reservas son cooperativas: avisan y evitan que otro arnés reserve el mismo fichero. No
        impiden que un editor lo modifique. Una reserva huérfana se conserva hasta que la liberes.
      </p>
      {list.length === 0 && <p className="text-ink-2">No hay ficheros reservados.</p>}
      <ul className="space-y-2">
        {list.map((r) => (
          <li
            key={r.id}
            className="flex flex-wrap items-start gap-3 rounded-md border border-line p-3"
          >
            <div className="min-w-0 flex-1">
              <p className="break-all font-mono text-[12px]">{r.path}</p>
              <p className="mt-1 break-words">{r.reason}</p>
              <p className="mt-1 break-all text-[12px] text-ink-2">
                {r.owner === "user"
                  ? "Tú"
                  : (data.agents.find((a) => a.id === r.owner)?.name ?? r.owner)}{" "}
                · {STATE[r.status]}
              </p>
            </div>
            <button
              type="button"
              className="btn"
              disabled={action.isPending}
              onClick={() => {
                if (window.confirm(`¿Liberar la reserva de ${r.path}?`))
                  action.mutate({ path: `/reservations/${r.id}`, method: "DELETE" });
              }}
            >
              Liberar
            </button>
          </li>
        ))}
      </ul>
      <details className="rounded-md border border-line p-4">
        <summary className="cursor-pointer font-medium">Reservar ficheros para mí</summary>
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            action.mutate({
              path: "/reservations",
              body: {
                location: f.get("location"),
                paths: String(f.get("paths"))
                  .split("\n")
                  .map((p) => p.trim())
                  .filter(Boolean),
                reason: f.get("reason"),
              },
            });
          }}
        >
          <label className="block">
            Proyecto
            <select name="location" required className={`${field} mt-1`}>
              {terminals.data?.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            Rutas relativas · una por línea
            <textarea
              name="paths"
              required
              rows={3}
              className={`${field} mt-1`}
              placeholder="src/example.ts"
            />
          </label>
          <label className="block">
            Motivo
            <input name="reason" required maxLength={500} className={`${field} mt-1`} />
          </label>
          <button type="submit" className="btn" disabled={action.isPending}>
            Reservar ficheros
          </button>
        </form>
      </details>
      {action.isError && <ErrorState error={action.error} />}
    </div>
  );
}
