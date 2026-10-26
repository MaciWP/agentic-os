import type { ReactNode } from "react";
import type {
  MailProfile,
  SenderCount,
  SenderStat,
} from "../../../server/features/google/client.ts";
import { Icon } from "../../icons.tsx";
import { DisabledState, ErrorState, isOff, SkeletonRows } from "../../ui.tsx";
import { Quiet } from "./parts.tsx";
import { useEscape } from "./thread.tsx";

// «Ver tu perfil de correo»: what the user already does with their mail, read from Gmail
// (trash, labels, sent mail, unread share per sender). Nothing here writes; the categorizer
// (home/mail-sort.tsx) learns from this same profile.

type Read = {
  isPending: boolean;
  isFetching: boolean;
  isError: boolean;
  error: unknown;
  data?: MailProfile | { disabled: true };
  refetch: () => unknown;
};

const CATEGORY: Record<string, string> = {
  PROMOTIONS: "Promociones",
  SOCIAL: "Social",
  UPDATES: "Notificaciones",
  FORUMS: "Foros",
  PERSONAL: "Principal",
};

export function CleanupView({
  q,
  onClose,
  onReload,
}: {
  q: Read;
  onClose: () => void;
  onReload: () => void;
}) {
  useEscape(onClose);
  const p = q.data && !isOff(q.data) ? q.data : undefined;
  return (
    <article
      aria-labelledby="cleanup-title"
      className="mx-auto w-full max-w-[760px] px-5 py-5 md:px-8"
    >
      <div className="flex items-center gap-2 text-[12px] text-ink-2">
        <button type="button" className="btn-ghost -ml-2" onClick={onClose} title="Esc">
          <Icon name="close" size={12} /> Cerrar
        </button>
        <span className="flex-1" />
        {p && (
          <button type="button" className="btn-ghost" onClick={onReload} disabled={q.isFetching}>
            {q.isFetching ? "Leyendo…" : "Volver a leer"}
          </button>
        )}
      </div>
      <h1 id="cleanup-title" className="mt-3 text-[20px] leading-7 font-semibold">
        Tu perfil de correo
      </h1>
      <p className="mt-1 text-[13px] text-ink-2">
        Lo que ya haces con tu correo. «Categorizar» aprende de aquí; nada se mueve sin tu
        confirmación en el Mac.
      </p>
      {q.isPending ? (
        <div className="mt-4">
          <p className="text-[12px] text-ink-2">Leyendo tu correo: puede tardar un minuto.</p>
          <SkeletonRows count={6} />
        </div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.data && isOff(q.data) ? (
        <DisabledState provider="Google" />
      ) : p ? (
        <Profile p={p} />
      ) : null}
    </article>
  );
}

function Profile({ p }: { p: MailProfile }) {
  return (
    <div className="mt-5 flex flex-col gap-6">
      <p className="text-[12px] text-ink-2">
        Muestra: {p.sampled.trash} en la papelera, {p.sampled.sent} enviados, {p.sampled.recent}{" "}
        recibidos recientes y {p.sampled.labels} en tus etiquetas.
      </p>
      <Block title="Lo que borras" hint="papelera, últimos 30 días">
        {p.trash.length === 0 ? (
          <Quiet>
            La papelera está vacía: partiré de un perfil por defecto que podrás corregir.
          </Quiet>
        ) : (
          <Counts rows={p.trash} />
        )}
      </Block>
      <Block title="Dónde guardas" hint="tus etiquetas">
        {p.labels.length === 0 ? (
          <Quiet>No tienes etiquetas propias con correo.</Quiet>
        ) : (
          <ul className="flex flex-col gap-3">
            {p.labels.map((l) => (
              <li key={l.name}>
                <p className="text-[13px] font-semibold">{l.name}</p>
                <p className="text-[12px] text-ink-2">{l.senders.map((s) => s.name).join(" · ")}</p>
              </li>
            ))}
          </ul>
        )}
      </Block>
      <Block title="Con quién hablas" hint="enviados: nunca será basura">
        {p.correspondents.length === 0 ? (
          <Quiet>No hay correo enviado.</Quiet>
        ) : (
          <Counts rows={p.correspondents} />
        )}
      </Block>
      <Block title="Quién te escribe más" hint="recibidos recientes">
        {p.senders.length === 0 ? (
          <Quiet>No hay correo recibido.</Quiet>
        ) : (
          <Senders rows={p.senders} />
        )}
      </Block>
    </div>
  );
}

function Block({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h2 className="text-[15px] font-semibold">
        {title} <span className="text-[12px] font-normal text-ink-2">· {hint}</span>
      </h2>
      {children}
    </section>
  );
}

function Counts({ rows }: { rows: SenderCount[] }) {
  return (
    <ol className="flex flex-col">
      {rows.map((s) => (
        <li key={s.address} className="flex items-baseline gap-3 py-0.5 text-[13px]">
          <span className="min-w-0 flex-1 truncate" title={s.address}>
            {s.name}
          </span>
          <span className="shrink-0 tabular-nums text-ink-2">{s.count}</span>
        </li>
      ))}
    </ol>
  );
}

function Senders({ rows }: { rows: SenderStat[] }) {
  return (
    <table className="w-full text-[13px]">
      <thead className="text-left text-[12px] text-ink-2">
        <tr>
          <th className="py-1 font-normal">Remitente</th>
          <th className="py-1 font-normal">Categoría</th>
          <th className="py-1 text-right font-normal">Correos</th>
          <th className="py-1 text-right font-normal">Sin abrir</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => (
          <tr key={s.address} className="border-t border-line">
            <td className="max-w-0 truncate py-1 pr-3" title={s.address}>
              {s.name}
            </td>
            <td className="py-1 pr-3 text-ink-2">{s.category ? CATEGORY[s.category] : "—"}</td>
            <td className="py-1 text-right tabular-nums">{s.count}</td>
            <td className="py-1 text-right tabular-nums">
              {Math.round((s.unread / s.count) * 100)} %
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
