import { cn } from "cn";
import type { ReactNode } from "react";
import { ApiError } from "../../api.ts";
import { plural, relativeTime } from "../../format.ts";
import { Section } from "../today/parts.tsx";
import { MAIL_DRAG, type MailItem } from "./today-model.ts";

// One inbox beside «Hoy»: Trabajo (Outlook through the Mac) on the left, Personal (Gmail) on
// the right. A row opens the mail in the centre; dragged to «Hoy», or with «Tarea», it becomes
// a task linked to it. Nothing here changes the mail.

// What AgenticMac's reasons mean to the user (server/features/mac/run.ts): a closed Mail or a
// missing grant is something to fix, never an empty inbox.
const MAC_TITLE: Record<string, string> = {
  mail_closed: "Abre Mail para leer Outlook",
  not_granted: "AgenticMac necesita permiso en Privacidad y seguridad",
  denied: "macOS ha denegado el acceso a AgenticMac",
  no_exchange: "No hay ninguna cuenta Exchange en Cuentas de Internet",
  no_inbox: "Mail no encuentra la bandeja de Exchange",
  not_installed: "Falta AgenticMac: ejecuta bun run mac:build",
  timeout: "Mail no ha respondido a tiempo",
  not_found: "Ese correo ya no está en la bandeja",
};
export const macTitle = (error: unknown) =>
  error instanceof ApiError ? MAC_TITLE[error.code] : undefined;

type Read<T> = {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  data?: T | { disabled: true };
  refetch: () => unknown;
};

export function MailColumn<T>({
  label,
  provider,
  q,
  read,
  open,
  linked,
  onOpen,
  onTask,
  errorTitle,
  footer,
}: {
  label: string;
  provider: string;
  q: Read<T>;
  read: (data: T) => { items: MailItem[]; total: number };
  open: string | null;
  // The mails already behind a task, by their key.
  linked: ReadonlySet<string>;
  onOpen: (m: MailItem) => void;
  onTask: (m: MailItem) => void;
  errorTitle?: (error: unknown) => string | undefined;
  footer?: ReactNode;
}) {
  const now = Date.now();
  return (
    <div className="flex flex-col gap-3">
      <Section
        title={label}
        q={q}
        provider={provider}
        errorTitle={errorTitle}
        count={(d) => {
          const { items, total } = read(d);
          return items.length < total
            ? `${items.length} de ${total}`
            : plural(total, "correo", "correos");
        }}
      >
        {(d) => {
          const { items } = read(d);
          return items.length === 0 ? (
            <p className="px-1 py-2 text-[13px] text-ink-2">La bandeja de entrada está vacía.</p>
          ) : (
            <ol className="flex flex-col">
              {items.map((m) => (
                <MailRow
                  key={m.id}
                  m={m}
                  now={now}
                  open={m.id === open}
                  linked={linked.has(m.key)}
                  onOpen={onOpen}
                  onTask={onTask}
                />
              ))}
            </ol>
          );
        }}
      </Section>
      {footer}
    </div>
  );
}

function MailRow({
  m,
  now,
  open,
  linked,
  onOpen,
  onTask,
}: {
  m: MailItem;
  now: number;
  open: boolean;
  linked: boolean;
  onOpen: (m: MailItem) => void;
  onTask: (m: MailItem) => void;
}) {
  const subject = m.subject ?? "(sin asunto)";
  return (
    <li
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData(
          MAIL_DRAG,
          JSON.stringify({ account: m.account, key: m.key, subject: m.subject }),
        );
        e.dataTransfer.setData("text/plain", subject);
      }}
      className={cn(
        "group flex items-start gap-1 rounded-md hover:bg-[var(--selected)]",
        open && "bg-[var(--selected)]",
      )}
    >
      <button
        type="button"
        data-thread={m.id}
        aria-current={open ? "true" : undefined}
        onClick={() => onOpen(m)}
        className="flex min-w-0 flex-1 flex-col gap-0.5 px-2 py-1.5 text-left"
      >
        <span className="flex w-full items-center gap-2 text-[13px]">
          {m.unread && <span className="size-1.5 shrink-0 rounded-full bg-primary" />}
          <span className={cn("min-w-0 flex-1 truncate", m.unread && "font-semibold")}>
            {m.from || "(sin remitente)"}
          </span>
          {m.flagged && (
            <span className="text-warn">
              <span aria-hidden>★</span>
              <span className="sr-only">Marcado</span>
            </span>
          )}
          <span className="shrink-0 text-[12px] text-ink-2">{relativeTime(m.at, now)}</span>
        </span>
        <span className="w-full truncate text-[13px] text-ink">{subject}</span>
        {m.snippet && <span className="w-full truncate text-[12px] text-ink-2">{m.snippet}</span>}
      </button>
      {linked ? (
        <span className="shrink-0 px-2 py-1.5 text-[11px] text-ink-2">En Hoy</span>
      ) : (
        <button
          type="button"
          className="btn-ghost mt-1 shrink-0 px-1.5 text-[11px] opacity-70 group-hover:opacity-100 focus-visible:opacity-100"
          aria-label={`Crear tarea: ${subject}`}
          onClick={() => onTask(m)}
        >
          Tarea
        </button>
      )}
    </li>
  );
}
