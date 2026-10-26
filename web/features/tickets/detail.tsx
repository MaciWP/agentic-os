import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { Ticket } from "../../../server/features/jira/issues.ts";
import { relativeTime } from "../../format.ts";
import { DisabledState, ErrorState, isOff, SkeletonRows } from "../../ui.tsx";
import { LaunchAgent } from "../terminals/launch.tsx";
import { AdfView, InlineMarkdown } from "./adf-view.tsx";
import { JiraStatus, TypeIcon } from "./icons.tsx";
import { Estimate } from "./list.tsx";
import { useTicket } from "./queries.ts";

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-2">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1.5">{children}</dd>
    </>
  );
}

// `extra` is what the page shows about the ticket beyond Jira's own fields, before the launch.
export function TicketDetail({
  ticketKey,
  extra,
}: {
  ticketKey: string;
  extra?: (t: Ticket) => ReactNode;
}) {
  const query = useTicket(ticketKey);
  if (query.isPending) return <SkeletonRows count={8} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  if (isOff(query.data)) return <DisabledState provider="Jira" />;
  const t = query.data;

  return (
    <article aria-labelledby="ticket-title" className="mx-auto max-w-[760px] px-5 py-5 md:px-8">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-[12px] text-ink-2">
        <div className="basis-full md:hidden">
          <Link to="/tickets" search={(s) => s} className="btn-ghost -ml-2">
            ← Tickets
          </Link>
        </div>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {t.parent && (
            <>
              <TypeIcon type={t.parent.type} />
              <span className="shrink-0 whitespace-nowrap font-mono">{t.parent.key}</span>
              <span className="min-w-0 truncate">{t.parent.summary}</span>
              <span aria-hidden>›</span>
            </>
          )}
          <span className="shrink-0 whitespace-nowrap font-mono">{t.key}</span>
        </span>
        <a
          href={t.url}
          target="_blank"
          rel="noreferrer noopener"
          className="btn-ghost shrink-0 whitespace-nowrap"
        >
          Abrir en Jira ↗
        </a>
      </div>

      <h1 id="ticket-title" className="mt-3 text-[20px] leading-7 font-semibold text-balance">
        {t.summary}
      </h1>

      <dl className="mt-4 grid grid-cols-[96px_1fr] gap-x-4 gap-y-2 border-y border-line py-3">
        <Prop label="Estado">
          <JiraStatus status={t.status} />
        </Prop>
        <Prop label="Tipo">
          <TypeIcon type={t.issuetype} />
          <span>{t.issuetype}</span>
        </Prop>
        <Prop label="Estimación">
          <Estimate points={t.points} size={t.size} />
          {t.points === null && t.size === null && <span className="text-ink-2">Sin estimar</span>}
        </Prop>
        {t.priority && <Prop label="Prioridad">{t.priority}</Prop>}
        {t.labels.length > 0 && (
          <Prop label="Etiquetas">
            {t.labels.map((l) => (
              <span key={l} className="pill">
                {l}
              </span>
            ))}
          </Prop>
        )}
        <Prop label="Actualizado">
          <time dateTime={t.updated} title={new Date(t.updated).toLocaleString("es")}>
            {relativeTime(t.updated)}
          </time>
        </Prop>
      </dl>

      {extra?.(t)}

      <details className="mt-5">
        <summary className="cursor-pointer text-[12px] text-ink-2">
          Lanzar otro agente a mano
        </summary>
        <LaunchAgent ticketKey={t.key} />
      </details>

      <section aria-labelledby="ac-title" className="mt-6">
        <h2 id="ac-title" className="section-title">
          Criterios de aceptación
          {t.acceptanceCriteria.length > 0 && (
            <span className="text-ink-2 tabular-nums"> {t.acceptanceCriteria.length}</span>
          )}
        </h2>
        {t.acceptanceCriteria.length === 0 ? (
          <p className="mt-2 text-ink-2">Sin ACs detectados en la descripción.</p>
        ) : (
          <ol className="mt-2 space-y-1.5">
            {t.acceptanceCriteria.map((ac, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: ACs can repeat and have no id
              <li key={i} className="flex gap-2.5">
                <span className="mt-[3px] size-3.5 shrink-0 rounded-[4px] border border-ink-2/50" />
                <span>
                  <InlineMarkdown text={ac} />
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="desc-title" className="mt-8">
        <h2 id="desc-title" className="section-title">
          Descripción
        </h2>
        <div className="mt-2">
          <AdfView doc={t.descriptionAdf} />
        </div>
      </section>
    </article>
  );
}
