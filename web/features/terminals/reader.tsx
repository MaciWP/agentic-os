import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { memo, useEffect, useLayoutEffect, useRef } from "react";
import { Conversation } from "../../../shared/terminals.ts";
import { ApiError, api, unwrap } from "../../api.ts";
import { clockTime } from "../../format.ts";
import { pollEvery } from "../../poll.ts";
import { errorText } from "../../ui.tsx";
import { Prose } from "../memory/prose.tsx";
import { kindLabel, type TerminalInfo } from "./queries.ts";

export const READ_POLL_MS = 3000;

// Claude and Codex keep a transcript the server can read; the others are read in the terminal.
export const canRead = (t: TerminalInfo | undefined) =>
  t?.harness === "claude" || t?.harness === "codex";

// The agent's conversation for a phone: its answers as Markdown (lists, code, tables), the
// user's words as typed, with native scroll and selection, at a size made for reading. It reads the transcript, never the terminal, so the window that
// holds the terminal keeps it and its size. Read again every few seconds while the page is
// visible, and at once when the agent's state changes. `status` off leaves the agent's state
// to the header (a phone shows it there, and the ask card shows what it asks).
export function ConversationReader({
  info,
  font,
  status = true,
  onTerminal,
}: {
  info: TerminalInfo;
  font: number;
  status?: boolean;
  onTerminal: () => void;
}) {
  const id = info.id;
  const q = useQuery({
    queryKey: ["conversation", id, info.agent?.state ?? null, info.agent?.asks ?? null],
    queryFn: async () =>
      Conversation.parse(
        await unwrap(await api.api.agents[":id"].conversation.$get({ param: { id } })),
      ),
    refetchInterval: pollEvery(READ_POLL_MS),
    placeholderData: keepPreviousData,
  });
  const scroller = useRef<HTMLDivElement>(null);
  // Follows new messages while the reader is at the bottom; a scroll up to read stays put.
  const atBottom = useRef(true);
  const messages = q.data?.messages;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && messages && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);
  // The phone's keyboard shrinks the reader: the last message stays in view.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const who = kindLabel(info);
  const ask = info.agent?.asks;
  const none = q.error instanceof ApiError && q.error.code === "no_conversation";
  return (
    <div
      data-conversation
      className="absolute inset-0 z-10 flex min-h-0 flex-col bg-term-bg"
      style={{ fontSize: `${font + 2}px` }}
    >
      {status && (ask || info.agent?.state) && (
        <p
          role="status"
          className={`flex shrink-0 items-center gap-2 px-3 py-1.5 text-[13px] ${ask ? "bg-term-ask" : "text-white/60"}`}
        >
          <span className="min-w-0 flex-1">
            {ask === "permission"
              ? `${who} pide permiso en la terminal.`
              : ask === "question"
                ? `${who} te pregunta en la terminal.`
                : info.agent?.state === "working"
                  ? `${who} está trabajando…`
                  : `${who} espera tu respuesta.`}
          </span>
          {ask && (
            <button type="button" className="btn min-h-11 shrink-0" onClick={onTerminal}>
              Ver terminal
            </button>
          )}
        </p>
      )}
      <div
        ref={scroller}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-3 py-2"
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {q.error && !none && (
          <p role="alert" className="text-[13px] text-bad">
            No se ha podido leer la conversación: {errorText(q.error)}.
          </p>
        )}
        {none ? (
          <div className="space-y-2 text-[13px] text-white/70">
            <p>Esta sesión todavía no tiene una conversación que leer.</p>
            <button type="button" className="btn min-h-11" onClick={onTerminal}>
              Ver terminal
            </button>
          </div>
        ) : q.isPending ? (
          <p className="text-[13px] text-white/60">Cargando la conversación…</p>
        ) : messages?.length === 0 ? (
          <p className="text-[13px] text-white/60">Todavía no hay mensajes.</p>
        ) : (
          messages?.map((m, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: an article holds no state, so a shifted index only redraws it
            <Message key={i} user={m.role === "user"} text={m.text} at={m.at} who={who} />
          ))
        )}
      </div>
    </div>
  );
}

// One message; the poll hands back equal values, so an unchanged one is not drawn again.
const Message = memo(function Message({
  user,
  text,
  at,
  who,
}: {
  user: boolean;
  text: string;
  at: string | null | undefined;
  who: string;
}) {
  return (
    <article
      aria-label={user ? "Tú" : who}
      className={`min-w-0 rounded-lg px-3 py-2 ${user ? "ml-6 bg-term-you" : "bg-term-other"}`}
    >
      <header className="mb-1 flex gap-2 text-[11px] text-white/50">
        <span>{user ? "Tú" : who}</span>
        <span>{at ? clockTime(at) : ""}</span>
      </header>
      {user ? (
        <p className="select-text whitespace-pre-wrap break-words leading-snug">{text}</p>
      ) : (
        <Prose
          text={text}
          frontMatter={false}
          className="max-w-none select-text break-words text-[1em] leading-normal text-term-ink [&>*+*]:mt-2 [&>h2]:mt-3 [&>h3]:mt-3"
        />
      )}
    </article>
  );
});
