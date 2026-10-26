import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { type KeyboardEvent, type ReactNode, useState } from "react";
import type { Meeting } from "../../../shared/meetings.ts";
import { GoalTitle, type Task } from "../../../shared/objectives.ts";
import { type ChipKind, parseTask } from "../../../shared/task-parse.ts";
import { useAccess } from "../../access.ts";
import { ApiError } from "../../api.ts";
import { clockTime } from "../../format.ts";
import { DisabledState, ErrorState, errorText, isOff, SkeletonRows } from "../../ui.tsx";
import { useObjectiveActions, useTasks } from "../objectives/queries.ts";
import { useTickets } from "../tickets/queries.ts";
import {
  grantCalendar,
  useAgenda,
  useMeetingActions,
  useMeetingSync,
  useOpenMeetings,
  useOutlookAgenda,
} from "../today/queries.ts";
import { casesOf, SourceProblems, State } from "./cases.tsx";
import { useInboxData } from "./data.ts";
import { Action } from "./inicio.tsx";
import { macTitle } from "./mail-column.tsx";
import { MeetingActions } from "./meeting-note.tsx";
import { Who } from "./parts.tsx";
import {
  calendarsOf,
  type Day,
  isDone,
  MAIL_DRAG,
  type MeetingRow,
  moved,
  placedBefore,
  syncBody,
  TASK_DRAG,
  type TaskRow,
  taskFromMail,
  ticketOrder,
  timedRows,
  untimedRows,
} from "./today-model.ts";

// «Hoy», the centre of Inicio: what to do today, in one list. Meetings and timed tasks by the
// clock, then what waits on the user, then the tasks by priority and order, then what earlier
// days left open, then the assigned tickets. Nothing leaves on its own: a task stays until it is
// ticked, a meeting until it is closed.

// Where a task's mail is: openable, gone from the inbox, or not known yet.
export type MailLink = { open: () => void } | "moved" | null;

const SOURCE_NAME = { google: "Google", outlook: "Outlook" } as const;

export function TodayList({
  day,
  mailOf,
  onLanes,
  onNote,
}: {
  day: Day;
  mailOf: (task: Task) => MailLink;
  // Opens a meeting's note in the centre, made the first time with these attendees.
  onNote: (meeting: Meeting, attendees: string[]) => void;
  // Opens «Ticket a ticket» in the centre: each ticket with its agents and PR.
  onLanes: () => void;
}) {
  const google = useAgenda();
  const outlook = useOutlookAgenda();
  const calendars = calendarsOf(google, outlook);
  // One sync once every calendar answered or failed, not one per calendar as each arrives.
  const sync = useMeetingSync(syncBody(day, calendars), !google.isPending && !outlook.isPending);
  const earlier = useOpenMeetings(day.from);
  const tasks = useTasks(day);
  const act = useObjectiveActions();
  const meet = useMeetingActions();
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const run = (p: Promise<unknown>) => {
    setError(null);
    p.catch((err) => setError(errorText(err)));
  };

  const events = [...(calendars.google ?? []), ...(calendars.outlook ?? [])];
  const taskList = tasks.data?.tasks ?? [];
  const timed = timedRows(day, events, sync.data?.meetings ?? [], taskList);
  const untimed = untimedRows(day, taskList);

  return (
    <section
      aria-label="Hoy"
      className={cn(
        "flex flex-col gap-6 rounded-lg outline-2 outline-offset-4 outline-transparent",
        over && "outline-dashed outline-primary",
      )}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(MAIL_DRAG)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        setOver(false);
        const raw = e.dataTransfer.getData(MAIL_DRAG);
        if (!raw) return;
        e.preventDefault();
        run(act.create(taskFromMail(JSON.parse(raw))));
      }}
    >
      <AddTask onAdd={(p) => act.create(p)} onError={setError} />
      {error && (
        <p role="alert" className="px-1 text-[12px] text-bad">
          {error}
        </p>
      )}

      <Block title="Agenda" count={timed.length}>
        <CalendarState name="Google" q={google} />
        <CalendarState name="Outlook" q={outlook} grantable />
        {sync.isError && (
          <p role="alert" className="px-1 text-[12px] text-bad">
            No se han podido guardar las reuniones: {errorText(sync.error)}
          </p>
        )}
        {timed.length === 0 ? (
          <Quiet>Ni reuniones ni tareas con hora hoy.</Quiet>
        ) : (
          <ol className="flex flex-col">
            {timed.map((r) =>
              r.kind === "meeting" ? (
                <MeetingItem
                  key={r.key}
                  r={r}
                  run={run}
                  onNote={(m) => onNote(m, r.event?.attendees ?? [])}
                />
              ) : (
                <TaskItem key={r.key} r={r} day={day} mail={mailOf(r.task)} run={run} at={r.at} />
              ),
            )}
          </ol>
        )}
      </Block>

      <Waiting />

      <Block title="Tareas" count={untimed.filter((r) => !isDone(r.task, day)).length}>
        {tasks.isPending ? (
          <SkeletonRows count={2} />
        ) : tasks.isError ? (
          <ErrorState error={tasks.error} onRetry={() => tasks.refetch()} />
        ) : untimed.length === 0 ? (
          <Quiet>Nada apuntado.</Quiet>
        ) : (
          <TaskOrder rows={untimed} day={day} mailOf={mailOf} run={run} />
        )}
      </Block>

      {earlier.isError ? (
        <ErrorState error={earlier.error} onRetry={() => earlier.refetch()} />
      ) : (
        (earlier.data?.meetings.length ?? 0) > 0 && (
          <Block
            title="Sin cerrar"
            count={earlier.data?.meetings.length ?? 0}
            action={
              <button
                type="button"
                className="btn-ghost text-[12px]"
                onClick={() => run(meet.closeBefore(day.from))}
              >
                Cerrar las de días anteriores
              </button>
            }
          >
            <ol className="flex flex-col">
              {earlier.data?.meetings.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-[var(--selected)]"
                >
                  <span className="w-[86px] shrink-0 text-[12px] text-ink-2 tabular-nums">
                    {shortDay(m.start)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    {m.title ?? "(sin título)"}
                  </span>
                  <span className="shrink-0 text-[11px] text-ink-2">{SOURCE_NAME[m.source]}</span>
                  <MeetingActions
                    meeting={m}
                    title={m.title ?? "(sin título)"}
                    onNote={() => onNote(m, [])}
                    run={run}
                  />
                </li>
              ))}
            </ol>
          </Block>
        )
      )}

      <Tickets onLanes={onLanes} />
    </section>
  );
}

const shortDay = (iso: string) =>
  new Intl.DateTimeFormat("es-ES", { weekday: "short", day: "numeric", month: "short" }).format(
    new Date(iso),
  );

const Quiet = ({ children }: { children: ReactNode }) => (
  <p className="px-1 py-1 text-[13px] text-ink-2">{children}</p>
);

function Block({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <header className="flex items-baseline gap-2 px-1">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {count !== undefined && count > 0 && (
          <span className="text-[12px] text-ink-2 tabular-nums">{count}</span>
        )}
        <span className="flex-1" />
        {action}
      </header>
      {children}
    </section>
  );
}

type Read = {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  data?: object;
  refetch: () => unknown;
};

// A calendar that is not answering says so above the list, so a quiet day is never a failed
// read. One that is off says nothing: it was never part of the day. `grantable`: a missing
// Calendars grant (Outlook through the Mac) offers «Dar permiso».
function CalendarState({
  name,
  q,
  grantable = false,
}: {
  name: string;
  q: Read;
  grantable?: boolean;
}) {
  if (q.isPending) return <Quiet>{name}: leyendo…</Quiet>;
  if (!q.isError) return null;
  const code = q.error instanceof ApiError ? q.error.code : null;
  return (
    <div role="alert" className="flex flex-col gap-1 px-1 text-[12px]">
      <p className="flex items-center gap-2 text-bad">
        <span className="min-w-0 flex-1">
          {name}:{" "}
          {code === "reconnect_required"
            ? "sin conectar"
            : (macTitle(q.error) ?? errorText(q.error))}
        </span>
        <button
          type="button"
          className="btn-ghost shrink-0 text-[12px]"
          onClick={() => q.refetch()}
        >
          Reintentar
        </button>
      </p>
      {grantable && (code === "not_granted" || code === "denied") && (
        <GrantCalendar onGranted={() => q.refetch()} />
      )}
    </div>
  );
}

// macOS asks on the Mac's screen; when it does not, the Calendars list opens there and the
// agenda is read again when the user comes back to this tab.
function GrantCalendar({ onGranted }: { onGranted: () => void }) {
  const access = useAccess();
  const [state, setState] = useState<"asking" | "settings" | "refused" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const remote = access.data?.desktop === false;
  const ask = () => {
    setState("asking");
    setError(null);
    grantCalendar()
      .then(({ calendar, settings }) => {
        if (calendar === "granted") return onGranted();
        setState(settings ? "settings" : "refused");
      })
      .catch((err) => {
        setState(null);
        setError(err);
      });
  };
  return (
    <p className="flex flex-wrap items-center gap-2 text-ink-2">
      <button
        type="button"
        className="btn shrink-0 text-[12px]"
        disabled={remote || state === "asking"}
        onClick={ask}
      >
        {state === "asking" ? "Esperando a macOS…" : "Dar permiso"}
      </button>
      <span className="min-w-0 flex-1">
        {remote
          ? "Se da desde el Mac: el aviso de macOS sale en su pantalla."
          : error !== null
            ? `No se ha podido pedir el permiso: ${errorText(error)}`
            : state === "settings"
              ? "Se ha abierto Ajustes: marca AgenticMac en Calendarios y vuelve aquí."
              : state === "refused"
                ? "macOS no ha dado el permiso."
                : "macOS te preguntará en el Mac si AgenticMac puede leer tus calendarios."}
      </span>
    </p>
  );
}

// The typed line and what the rules read in it, as chips the user can take back.
function AddTask({
  onAdd,
  onError,
}: {
  onAdd: (
    goal: Parameters<ReturnType<typeof useObjectiveActions>["create"]>[0],
  ) => Promise<unknown>;
  onError: (message: string | null) => void;
}) {
  const [text, setText] = useState("");
  const [drop, setDrop] = useState<ReadonlySet<ChipKind>>(new Set());
  const parsed = text.trim() ? parseTask(text, new Date(), drop) : null;
  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (!parsed) return;
        const title = GoalTitle.safeParse(parsed.title);
        if (!title.success) return onError("Escribe la tarea: hasta 200 caracteres.");
        onError(null);
        onAdd({
          title: title.data,
          dueOn: parsed.dueOn,
          dueHm: parsed.dueHm,
          priority: parsed.priority,
          about: parsed.about,
        })
          .then(() => {
            setText("");
            setDrop(new Set());
          })
          .catch((err) => onError(errorText(err)));
      }}
    >
      <input
        aria-label="Nueva tarea"
        placeholder="Añadir… (mañana 16:00, viernes, urgente, ABC-12)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="w-full rounded border border-line bg-panel px-2 py-1.5 text-[13px]"
      />
      {parsed && parsed.chips.length > 0 && (
        <ul aria-label="Leído en la tarea" className="flex flex-wrap gap-1 px-1">
          {parsed.chips.map((c) => (
            <li key={c.kind}>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-2 hover:text-ink"
                aria-label={`Quitar ${c.label}`}
                onClick={() => setDrop((d) => new Set([...d, c.kind]))}
              >
                {c.label} <span aria-hidden>×</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

function MeetingItem({
  r,
  run,
  onNote,
}: {
  r: MeetingRow;
  run: Run;
  onNote: (m: Meeting) => void;
}) {
  const now = Date.now();
  const live = !r.allDay && Date.parse(r.start) <= now && now < Date.parse(r.end);
  const closed = r.meeting?.closedAt != null;
  const join = r.event?.meet ?? r.event?.link ?? null;
  const title = r.title ?? "(sin título)";
  return (
    <li
      className={cn(
        "flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-[var(--selected)]",
        closed && "opacity-55",
      )}
    >
      <span className="w-[86px] shrink-0 text-[12px] text-ink-2 tabular-nums">
        {r.allDay ? "Todo el día" : `${clockTime(r.start)}–${clockTime(r.end)}`}
      </span>
      <span className={cn("min-w-0 flex-1 truncate text-[13px]", closed && "line-through")}>
        {title}
      </span>
      {live && <span className="text-[11px] font-medium text-primary">ahora</span>}
      <span className="shrink-0 text-[11px] text-ink-2">{SOURCE_NAME[r.source]}</span>
      {join && (
        <a
          href={join}
          target="_blank"
          rel="noreferrer"
          className="btn-ghost shrink-0 text-[12px]"
          aria-label={`Abrir ${title}`}
        >
          {r.event?.meet ? "Unirse" : "Abrir"}
        </a>
      )}
      {r.meeting && (
        <MeetingActions
          meeting={r.meeting}
          title={title}
          onNote={() => r.meeting && onNote(r.meeting)}
          run={run}
        />
      )}
    </li>
  );
}

type Run = (p: Promise<unknown>) => void;

// The tasks with no time, in the user's order: drag a row onto another, or Alt+↑/↓ on it.
function TaskOrder({
  rows,
  day,
  mailOf,
  run,
}: {
  rows: TaskRow[];
  day: Day;
  mailOf: (task: Task) => MailLink;
  run: Run;
}) {
  const act = useObjectiveActions();
  const tasks = rows.map((r) => r.task);
  const move = (index: number, step: -1 | 1) => {
    const t = tasks[index];
    const position = moved(tasks, index, step);
    if (!t || position === null) return;
    run(act.patch(t.id, { position }));
  };
  return (
    <ol className="flex flex-col">
      {rows.map((r, i) => (
        <TaskItem
          key={r.key}
          r={r}
          day={day}
          mail={mailOf(r.task)}
          run={run}
          onKeyDown={(e) => {
            if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
            e.preventDefault();
            move(i, e.key === "ArrowUp" ? -1 : 1);
          }}
          onDropTask={(id) => {
            const dragged = tasks.find((t) => t.id === id);
            if (!dragged || id === r.task.id || dragged.priority !== r.task.priority) return;
            const others = tasks.filter((t) => t.id !== id);
            run(act.patch(id, { position: placedBefore(others, r.task.id) }));
          }}
        />
      ))}
    </ol>
  );
}

function TaskItem({
  r,
  day,
  mail,
  run,
  at,
  onKeyDown,
  onDropTask,
}: {
  r: TaskRow;
  day: Day;
  mail: MailLink;
  run: Run;
  at?: string;
  onKeyDown?: (e: KeyboardEvent) => void;
  onDropTask?: (id: number) => void;
}) {
  const act = useObjectiveActions();
  const t = r.task;
  // A tick shows at once; it is dropped when the list is read again, or the write failed.
  const [ticking, setTicking] = useState<boolean | null>(null);
  const done = ticking ?? isDone(t, day);
  const toggle = () => {
    setTicking(!done);
    run((done ? act.reopen(t.id) : act.close(t.id)).finally(() => setTicking(null)));
  };
  const [target, setTarget] = useState(false);
  const draggable = onDropTask !== undefined && !done;
  return (
    <li
      draggable={draggable}
      onKeyDown={onKeyDown}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(TASK_DRAG, String(t.id));
      }}
      onDragOver={(e) => {
        if (!onDropTask || !e.dataTransfer.types.includes(TASK_DRAG)) return;
        e.preventDefault();
        setTarget(true);
      }}
      onDragLeave={() => setTarget(false)}
      onDrop={(e) => {
        setTarget(false);
        const id = Number(e.dataTransfer.getData(TASK_DRAG));
        if (!onDropTask || !id) return;
        e.preventDefault();
        e.stopPropagation();
        onDropTask(id);
      }}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1 text-[13px] hover:bg-[var(--selected)]",
        target && "shadow-[inset_0_2px_0_var(--color-primary)]",
      )}
    >
      {at !== undefined && (
        <span className="w-[86px] shrink-0 text-[12px] text-ink-2 tabular-nums">{at}</span>
      )}
      <label
        className={cn("flex min-w-0 flex-1 items-center gap-2", done && "text-ink-2 line-through")}
      >
        <input type="checkbox" checked={done} onChange={toggle} />
        <span className="min-w-0 flex-1 truncate">{t.title}</span>
      </label>
      {r.note && (
        <span
          className={cn("shrink-0 text-[11px]", r.note === "vencida" ? "text-bad" : "text-ink-2")}
        >
          {r.note}
        </span>
      )}
      {t.about && (
        <Link
          to="/tickets/$key"
          params={{ key: t.about }}
          className="btn-ghost shrink-0 font-mono text-[11px]"
        >
          {t.about}
        </Link>
      )}
      {mail === "moved" ? (
        <span className="shrink-0 text-[11px] text-ink-2">Correo movido</span>
      ) : (
        mail && (
          <button
            type="button"
            className="btn-ghost shrink-0 text-[11px]"
            aria-label={`Abrir el correo de ${t.title}`}
            onClick={mail.open}
          >
            Correo
          </button>
        )
      )}
      {!done && (
        <button
          type="button"
          className={cn(
            "btn-ghost shrink-0 px-1.5 text-[12px] font-semibold",
            t.priority ? "text-warn" : "text-ink-2 opacity-50 hover:opacity-100",
          )}
          aria-pressed={t.priority === 1}
          aria-label={`Prioridad: ${t.title}`}
          onClick={() => run(act.patch(t.id, { priority: t.priority ? 0 : 1 }))}
        >
          !
        </button>
      )}
    </li>
  );
}

// What waits on the user from the rest of the app: an agent asking, a failed terminal, a PR
// to review. A source that was not read says so above.
function Waiting() {
  const data = useInboxData();
  const cases = casesOf(data).filter(
    (c) => c.level === "failed" || c.level === "asks" || c.level === "review",
  );
  return (
    <Block title="Te esperan" count={cases.length}>
      <SourceProblems data={data} />
      {cases.length === 0 ? (
        data.coverage.needs.complete && <Quiet>Nada te espera.</Quiet>
      ) : (
        <ol className="flex flex-col">
          {cases.map((c) => (
            <li
              key={c.id}
              className="flex items-center gap-2 rounded-md px-2 py-1 text-[13px] hover:bg-[var(--selected)]"
            >
              <State c={c} />
              <Who s={c.s} />
              <span className="min-w-0 flex-1 truncate">{c.s.title}</span>
              <Action c={c} />
            </li>
          ))}
        </ol>
      )}
    </Block>
  );
}

// The tickets assigned to the user, last: in progress first. «Ticket a ticket» opens the lanes,
// which also hold the agents and goals with no ticket, so it shows whatever Jira answered.
function Tickets({ onLanes }: { onLanes: () => void }) {
  const q = useTickets();
  const rows = q.data && !isOff(q.data) ? ticketOrder(q.data.tickets) : [];
  return (
    <Block
      title="Tickets"
      count={rows.length}
      action={
        <button type="button" className="btn-ghost text-[12px]" onClick={onLanes}>
          Ticket a ticket
        </button>
      }
    >
      {q.isPending ? (
        <SkeletonRows count={2} />
      ) : q.isError ? (
        <ErrorState error={q.error} provider="jira" onRetry={() => q.refetch()} />
      ) : q.data && isOff(q.data) ? (
        <DisabledState provider="Jira" />
      ) : rows.length === 0 ? (
        <Quiet>Ningún ticket asignado abierto.</Quiet>
      ) : (
        <ol className="flex flex-col">
          {rows.map((t) => (
            <li key={t.key}>
              <Link
                to="/tickets/$key"
                params={{ key: t.key }}
                className="flex items-center gap-2 rounded-md px-2 py-1 text-[13px] hover:bg-[var(--selected)]"
              >
                <span className="shrink-0 font-mono text-[12px] text-ink-2">{t.key}</span>
                <span className="min-w-0 flex-1 truncate">{t.summary}</span>
                <span className="shrink-0 text-[11px] text-ink-2">{t.status.name}</span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </Block>
  );
}
