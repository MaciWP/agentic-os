import { useEffect, useRef } from "react";
import type { MailMessage, MailThreadFull } from "../../../server/features/google/client.ts";
import { relativeTime } from "../../format.ts";
import { Icon } from "../../icons.tsx";
import { DisabledState, ErrorState, isOff, SkeletonRows } from "../../ui.tsx";

// One mail thread read inside «Hoy» (a Gmail thread, or an Outlook mail as a thread of one):
// every message as plain text, oldest first. Bodies are never rendered as HTML; the original
// stays one click away in its app.

type Read = {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  data?: MailThreadFull | { disabled: true };
  refetch: () => unknown;
};

// Esc closes the panel shown in place of Inicio's lanes.
export function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}

export function ThreadView({
  q,
  onClose,
  app = "Gmail",
  errorTitle,
}: {
  q: Read;
  onClose: () => void;
  app?: "Gmail" | "Mail";
  errorTitle?: (error: unknown) => string | undefined;
}) {
  useEscape(onClose);

  const t = q.data && !isOff(q.data) ? q.data : undefined;
  // Opening a thread reads it from its title, for keyboards and screen readers alike.
  const title = useRef<HTMLHeadingElement>(null);
  const loaded = t !== undefined;
  useEffect(() => {
    if (loaded) title.current?.focus();
  }, [loaded]);
  const now = Date.now();
  return (
    <article
      aria-labelledby={t ? "thread-title" : undefined}
      aria-label={t ? undefined : "Hilo de correo"}
      className="mx-auto w-full max-w-[760px] px-5 py-5 md:px-8"
    >
      <div className="flex items-center gap-2 text-[12px] text-ink-2">
        <button type="button" className="btn-ghost -ml-2" onClick={onClose} title="Esc">
          <Icon name="close" size={12} /> Cerrar
        </button>
        <span className="flex-1" />
        {t && (
          <a href={t.link} target="_blank" rel="noreferrer noopener" className="btn-ghost">
            Abrir en {app} ↗
          </a>
        )}
      </div>
      {q.isPending ? (
        <SkeletonRows count={6} />
      ) : q.isError ? (
        <ErrorState error={q.error} title={errorTitle?.(q.error)} onRetry={() => q.refetch()} />
      ) : q.data && isOff(q.data) ? (
        <DisabledState provider={app === "Gmail" ? "Google" : "Outlook"} />
      ) : t ? (
        <>
          <h1
            id="thread-title"
            ref={title}
            tabIndex={-1}
            className="mt-3 text-[20px] leading-7 font-semibold text-balance outline-none"
          >
            {t.subject ?? "(sin asunto)"}
          </h1>
          <ol className="mt-4 flex flex-col">
            {t.messages.map((m) => (
              <MessageItem key={m.id} m={m} now={now} app={app} />
            ))}
          </ol>
        </>
      ) : null}
    </article>
  );
}

function MessageItem({ m, now, app }: { m: MailMessage; now: number; app: string }) {
  return (
    <li className="border-t border-line py-4">
      <div className="flex items-baseline gap-2 text-[13px]">
        <span className="min-w-0 flex-1 truncate font-semibold" title={m.from}>
          {m.from || "(sin remitente)"}
        </span>
        <time
          dateTime={m.at}
          title={new Date(m.at).toLocaleString()}
          className="shrink-0 text-[12px] text-ink-2"
        >
          {relativeTime(m.at, now)}
        </time>
      </div>
      {(m.to || m.cc) && (
        <p className="mt-0.5 truncate text-[12px] text-ink-2">
          {m.to && <>Para: {m.to}</>}
          {m.to && m.cc && " · "}
          {m.cc && <>Cc: {m.cc}</>}
        </p>
      )}
      {m.body === null ? (
        <p className="mt-3 text-[13px] text-ink-2">Sin texto: ábrelo en {app} para verlo.</p>
      ) : (
        <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-[13px] leading-5 text-ink">
          {m.body}
        </pre>
      )}
      {m.truncated && (
        <p className="mt-2 text-[12px] text-ink-2">Mensaje cortado: el resto está en {app}.</p>
      )}
    </li>
  );
}
