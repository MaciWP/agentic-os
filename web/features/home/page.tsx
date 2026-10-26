import { useCallback, useEffect, useMemo, useState } from "react";
import type { MailThreadFull } from "../../../server/features/google/client.ts";
import type { MailAccount } from "../../../shared/mail-sort.ts";
import type { Meeting } from "../../../shared/meetings.ts";
import type { Task } from "../../../shared/objectives.ts";
import { errorText, isOff } from "../../ui.tsx";
import { useObjectiveActions, useTasks } from "../objectives/queries.ts";
import { CleanupView } from "../today/cleanup.tsx";
import {
  useMail,
  useMailProfile,
  useMeetingActions,
  useOutlookInbox,
  useOutlookMessage,
  useThread,
} from "../today/queries.ts";
import { ThreadView, useEscape } from "../today/thread.tsx";
import { TicketLanes } from "./inicio.tsx";
import { MailColumn, macTitle } from "./mail-column.tsx";
import { ProposalView, SortActions } from "./mail-sort.tsx";
import { MeetingNoteView } from "./meeting-note.tsx";
import { DaySummary } from "./summary.tsx";
import { type MailLink, TodayList } from "./today-list.tsx";
import {
  type Day,
  fromGmail,
  fromOutlook,
  localDay,
  type MailItem,
  taskFromMail,
} from "./today-model.ts";

// Inicio, the landing page, in three columns: Trabajo (Outlook through the Mac), Hoy, Personal
// (Gmail). A mail opens in the centre in place of «Hoy» until it is closed. Below lg the
// columns stack with «Hoy» first.

type Centre =
  | { kind: "today" }
  | { kind: "mail"; account: "outlook" | "gmail"; id: string }
  | { kind: "cleanup" }
  | { kind: "lanes" }
  | { kind: "note"; meeting: Meeting; noteId: string }
  | { kind: "sort"; account: MailAccount };

// Today, which moves on at local midnight for a tab left open overnight. The same object while
// the day holds, so the queries keyed by it stay put.
function useToday(): Day {
  const [day, setDay] = useState(() => localDay(0));
  useEffect(() => {
    const timer = setInterval(() => {
      const now = localDay(0);
      setDay((d) => (d.day === now.day ? d : now));
    }, 60_000);
    return () => clearInterval(timer);
  }, []);
  return day;
}

export function InicioPage() {
  const day = useToday();
  const outlook = useOutlookInbox();
  const gmail = useMail();
  const tasks = useTasks(day);
  const act = useObjectiveActions();
  const meet = useMeetingActions();
  const [centre, setCentre] = useState<Centre>({ kind: "today" });
  const [error, setError] = useState<string | null>(null);
  const opened = centre.kind === "mail" ? centre : null;
  const thread = useThread(opened?.account === "gmail" ? opened.id : null);
  const message = useOutlookMessage(opened?.account === "outlook" ? opened.id : null);
  const profile = useMailProfile(centre.kind === "cleanup");

  const outlookItems = useMemo(
    () =>
      outlook.data && !isOff(outlook.data) ? outlook.data.messages.map(fromOutlook) : undefined,
    [outlook.data],
  );
  const linked = useMemo(
    () =>
      new Set(
        (tasks.data?.tasks ?? []).flatMap((t) =>
          t.source?.startsWith("mail:") && t.sourceKey ? [t.sourceKey] : [],
        ),
      ),
    [tasks.data],
  );

  const open = (m: Pick<MailItem, "account" | "id">) =>
    setCentre({ kind: "mail", account: m.account, id: m.id });
  const close = useCallback(() => {
    // The focus goes back to the row that opened the mail.
    if (opened) document.querySelector<HTMLElement>(`[data-thread="${opened.id}"]`)?.focus();
    setCentre({ kind: "today" });
  }, [opened]);
  const openNote = (m: Meeting, attendees: string[]) => {
    setError(null);
    meet
      .note(m.id, attendees)
      .then(({ meeting, noteId }) => setCentre({ kind: "note", meeting, noteId }))
      .catch((err) => setError(`No se ha podido abrir la nota: ${errorText(err)}`));
  };
  const toTask = (m: MailItem) => {
    setError(null);
    act
      .create(taskFromMail(m))
      .catch((err) => setError(`No se ha podido crear la tarea: ${errorText(err)}`));
  };
  // A Gmail thread opens by its id wherever it went; an Outlook mail only while it is in the
  // inbox this page read, since Mail's own id changes when it moves.
  const mailOf = (t: Task): MailLink => {
    if (!t.sourceKey) return null;
    if (t.source === "mail:gmail")
      return { open: () => open({ account: "gmail", id: t.sourceKey ?? "" }) };
    if (t.source !== "mail:outlook" || !outlookItems) return null;
    const m = outlookItems.find((o) => o.key === t.sourceKey);
    return m ? { open: () => open(m) } : "moved";
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DaySummary />
      {error && (
        <p role="alert" className="border-b border-line px-4 py-1 text-[12px] text-bad">
          {error}
        </p>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(260px,1fr)_minmax(420px,1.6fr)_minmax(260px,1fr)] lg:overflow-hidden">
        <aside
          aria-label="Trabajo"
          className="order-2 border-line px-4 pt-6 pb-6 lg:order-1 lg:overflow-y-auto lg:border-r lg:pb-28"
        >
          <MailColumn
            label="Trabajo"
            provider="Outlook"
            q={outlook}
            read={(d) => ({ items: d.messages.map(fromOutlook), total: d.total })}
            open={opened?.account === "outlook" ? opened.id : null}
            linked={linked}
            onOpen={open}
            onTask={toTask}
            errorTitle={macTitle}
            footer={
              <SortActions
                account="work"
                onReview={() => setCentre({ kind: "sort", account: "work" })}
              />
            }
          />
        </aside>
        <section
          aria-label="Centro"
          className="order-1 min-w-0 border-b border-line lg:order-2 lg:overflow-y-auto lg:border-b-0"
        >
          {centre.kind === "sort" ? (
            <ProposalView
              key={centre.account}
              account={centre.account}
              onClose={() => setCentre({ kind: "today" })}
            />
          ) : centre.kind === "note" ? (
            <MeetingNoteView
              key={centre.noteId}
              meeting={centre.meeting}
              noteId={centre.noteId}
              onBack={() => setCentre({ kind: "today" })}
            />
          ) : centre.kind === "lanes" ? (
            <LanesView onClose={() => setCentre({ kind: "today" })} />
          ) : centre.kind === "cleanup" ? (
            <CleanupView
              q={profile.q}
              onClose={() => setCentre({ kind: "today" })}
              onReload={profile.reload}
            />
          ) : centre.kind === "mail" && centre.account === "gmail" ? (
            <ThreadView key={centre.id} q={thread} onClose={close} />
          ) : centre.kind === "mail" ? (
            <ThreadView
              key={centre.id}
              q={{ ...message, data: message.data && asThread(message.data) }}
              onClose={close}
              app="Mail"
              errorTitle={macTitle}
            />
          ) : (
            <div className="mx-auto w-full max-w-[760px] px-4 pt-6 pb-28">
              <TodayList
                day={day}
                mailOf={mailOf}
                onLanes={() => setCentre({ kind: "lanes" })}
                onNote={openNote}
              />
            </div>
          )}
        </section>
        <aside
          aria-label="Personal"
          className="order-3 border-line px-4 pt-6 pb-6 lg:overflow-y-auto lg:border-l lg:pb-28"
        >
          <MailColumn
            label="Personal"
            provider="Google"
            q={gmail}
            read={(d) => ({ items: d.threads.map(fromGmail), total: d.total })}
            open={opened?.account === "gmail" ? opened.id : null}
            linked={linked}
            onOpen={open}
            onTask={toTask}
            footer={
              <div className="flex flex-col gap-2">
                <SortActions
                  account="personal"
                  onReview={() => setCentre({ kind: "sort", account: "personal" })}
                />
                <button
                  type="button"
                  className="btn-ghost self-start text-[12px]"
                  aria-pressed={centre.kind === "cleanup"}
                  onClick={() => setCentre({ kind: "cleanup" })}
                >
                  Ver tu perfil de correo
                </button>
              </div>
            }
          />
        </aside>
      </div>
    </div>
  );
}

// An Outlook mail as a thread of one, so one reader draws both accounts. `message:` opens it
// in Mail by its Message-ID.
function asThread(
  m: NonNullable<ReturnType<typeof useOutlookMessage>["data"]>,
): MailThreadFull | { disabled: true } {
  if (isOff(m)) return m;
  return {
    id: m.id,
    subject: m.subject,
    link: `message://${encodeURIComponent(`<${m.messageId}>`)}`,
    messages: [
      {
        id: m.id,
        from: m.from,
        to: m.to,
        cc: m.cc,
        at: m.at,
        body: m.body,
        truncated: m.truncated,
      },
    ],
  };
}

// «Ticket a ticket» in the centre: the lanes, with the way back to «Hoy».
function LanesView({ onClose }: { onClose: () => void }) {
  useEscape(onClose);
  return (
    <div className="flex min-h-0 flex-col">
      <button
        type="button"
        className="btn-ghost mx-4 mt-3 self-start text-[12px]"
        onClick={onClose}
        title="Esc"
      >
        ← Volver a Hoy
      </button>
      <TicketLanes />
    </div>
  );
}
