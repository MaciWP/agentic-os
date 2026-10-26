import type { AgendaEvent } from "../../../server/features/google/client.ts";
import type { MailThread } from "../../../shared/mail-inbox.ts";
import { clockTime, plural } from "../../format.ts";
import { isOff } from "../../ui.tsx";
import { useAgenda, useMail, useOutlookAgenda } from "../today/queries.ts";
import { useInboxData } from "./data.ts";
import type { Urgency } from "./inbox.ts";
import { known } from "./lanes.tsx";
import { mergedAgenda } from "./today-model.ts";

// The line on top of Inicio: the next meeting, what interrupts by kind, and the mail that waits.
// Fixed rules, no AI. A source that was not read says so, never a count of zero.

type Read<T> = { isPending: boolean; isError: boolean; data?: T | { disabled: true } };

export type SummaryInput = {
  agenda: Read<{ events: AgendaEvent[] }>;
  mail: Read<{ threads: MailThread[] }>;
  needs: { complete: boolean; byUrgency: Record<Exclude<Urgency, "idle">, number> };
  now: number;
};

const gap = (r: Read<unknown>, what: string) =>
  r.isPending
    ? `${what}: leyendo…`
    : r.isError
      ? `${what}: no se pudo leer`
      : `${what}: sin conectar`;

// The meeting going on, else the next one today that has not ended.
export function nextMeeting(events: AgendaEvent[], now: number) {
  const timed = events.filter((e) => !e.allDay && Date.parse(e.end) > now);
  const e = timed[0];
  if (!e) return null;
  return { e, live: Date.parse(e.start) <= now };
}

export function SummaryView({ agenda, mail, needs, now }: SummaryInput) {
  const events = agenda.data && !isOff(agenda.data) ? agenda.data.events : undefined;
  const threads = mail.data && !isOff(mail.data) ? mail.data.threads : undefined;
  const next = events && nextMeeting(events, now);
  const { failed, asks, review } = needs.byUrgency;
  const parts = [
    [asks, "agente te pregunta", "agentes te preguntan"],
    [review, "PR por revisar", "PRs por revisar"],
    [failed, "terminal falló", "terminales fallaron"],
  ] as const;
  const waiting = parts.filter(([n]) => n > 0);
  return (
    <section
      aria-label="Resumen del día"
      className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line px-4 py-2 text-[13px]"
    >
      <span>
        {!events ? (
          <span className="text-ink-2">{gap(agenda, "Agenda")}</span>
        ) : !next ? (
          <span className="text-ink-2">Sin más reuniones hoy</span>
        ) : (
          <a
            href={next.e.meet ?? next.e.link ?? undefined}
            target="_blank"
            rel="noreferrer"
            className="hover:underline"
          >
            {next.live ? "Ahora" : `Próxima ${clockTime(next.e.start)}`}:{" "}
            <span className="font-medium">{next.e.title ?? "(sin título)"}</span>
          </a>
        )}
      </span>
      <span className={waiting.length === 0 && needs.complete ? "text-ink-2" : ""}>
        {waiting.length === 0
          ? needs.complete
            ? "Nada te espera"
            : "Faltan datos para saber qué te espera"
          : waiting.map(([n, one, many]) => known(needs.complete, n, one, many, "")).join(" · ")}
      </span>
      <span className="text-ink-2">
        {!threads
          ? gap(mail, "Correo")
          : `${plural(threads.filter((t) => t.starred).length, "destacado", "destacados")} · ${plural(
              threads.filter((t) => t.unread).length,
              "sin leer",
              "sin leer",
            )}`}
      </span>
    </section>
  );
}

export function DaySummary() {
  // Both calendars: the next meeting is whichever comes first.
  const agenda = mergedAgenda(useAgenda(), useOutlookAgenda());
  const mail = useMail();
  const data = useInboxData();
  const byUrgency = { failed: 0, asks: 0, review: 0 };
  for (const n of data.inbox.needs) if (n.urgency !== "idle") byUrgency[n.urgency]++;
  return (
    <SummaryView
      agenda={agenda}
      mail={mail}
      needs={{ complete: data.coverage.needs.complete, byUrgency }}
      now={data.now}
    />
  );
}
