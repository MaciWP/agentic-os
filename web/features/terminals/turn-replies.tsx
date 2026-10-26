import { useState } from "react";
import { promptRefusal } from "../../../shared/work-bar.ts";
import { useWorkBar } from "../memory/queries.ts";
import { bringErrorText, bringTo } from "./bring.ts";
import type { TerminalInfo } from "./queries.ts";

// How many rituals a finished turn offers: the first ones of the bar, in its order.
const REPLIES = 4;

// The rituals on the bar as one-click replies to an agent that finished its turn: what the user
// types again and again («¿qué falta?», «¿100 % seguro?»), offered where the turn ends instead
// of in a bar out of the way. Sent the bar's way, with its context filled in; nothing shows
// while the agent works, asks or cannot take a prompt.
export function TurnReplies({
  t,
  limit = REPLIES,
  className = "",
}: {
  t: TerminalInfo;
  limit?: number;
  className?: string;
}) {
  const bar = useWorkBar().data?.buttons;
  const [sent, setSent] = useState<{ turn: string; text: string; ok: boolean } | null>(null);
  // A reply belongs to one turn: the next one starts clean.
  const turn = t.lastOutputAt ?? t.startedAt;
  const free = t.state === "running" && t.agent?.state === "needs_you" && !promptRefusal(t);
  if (!free || !bar?.length) return null;
  const send = async (prompt: string, label: string) => {
    try {
      await bringTo(t.id, { prompt });
      setSent({ turn, text: `«${label}» enviado`, ok: true });
    } catch (err) {
      setSent({ turn, text: `No se ha enviado «${label}»: ${bringErrorText(err)}`, ok: false });
    }
  };
  const said = sent?.turn === turn ? sent : null;
  return (
    <fieldset
      aria-label="Responder con un ritual"
      className={`flex min-w-0 flex-wrap items-center justify-end gap-1 ${className}`}
    >
      {said && (
        <span role="status" className={`text-[11px] ${said.ok ? "text-ink-2" : "text-bad"}`}>
          {said.text}
        </span>
      )}
      {bar.slice(0, limit).map((b) => (
        <button
          key={b.id}
          type="button"
          title={b.description ?? b.title}
          className="pill h-6 max-w-[14rem] truncate bg-[var(--panel)] px-2 text-[12px] text-ink shadow-sm hover:bg-[var(--hover)]"
          onClick={(e) => {
            e.stopPropagation();
            void send(b.id, b.label ?? b.title);
          }}
        >
          {b.label ?? b.title}
        </button>
      ))}
    </fieldset>
  );
}
