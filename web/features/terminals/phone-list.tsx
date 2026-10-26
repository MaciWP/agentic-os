import { Link } from "@tanstack/react-router";
import { errorText } from "../../ui.tsx";
import { seen, useWaiting } from "./attention.tsx";
import { readMesas } from "./mesas.ts";
import { rowText, shortPath, TerminalMarks, terminalState } from "./panel.tsx";
import { type TerminalInfo, useTerminals } from "./queries.ts";

// A phone's /terminales: the terminals as a list, the ones that need the user first, each a
// row that opens its own page (the agent's chat, or the screen). The Mesa stays one tap away.
// Ended ones wait folded at the end.
export function PhoneTerminals() {
  const q = useTerminals();
  const waiting = useWaiting();
  const all = q.data?.terminals ?? [];
  // Asks, then the user's turn, then the rest; the server's order within each.
  const rank = (t: TerminalInfo) =>
    t.agent?.asks || waiting.has(t.id) ? 0 : t.agent?.state === "needs_you" ? 1 : 2;
  const running = all
    .filter((t) => t.state === "running")
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)
    .map(({ t }) => t);
  const ended = all.filter((t) => t.state !== "running");
  return (
    <main className="mx-auto w-full max-w-xl px-3 py-3">
      <div className="mb-2 flex items-center gap-2">
        <h1 className="flex-1 text-[17px] font-semibold">Terminales</h1>
        <a
          className="btn min-h-11"
          href={`/terminales?mesa=${encodeURIComponent(readMesas().activeId)}`}
        >
          Ver la Mesa
        </a>
      </div>
      {q.error ? (
        <p role="alert" className="text-[14px] text-bad">
          No se han podido leer las terminales: {errorText(q.error)}.
        </p>
      ) : q.isPending ? (
        <p className="text-[14px] text-ink-2">Cargando…</p>
      ) : running.length === 0 ? (
        <p className="text-[14px] text-ink-2">No hay terminales en marcha.</p>
      ) : (
        <ul aria-label="Terminales en marcha" className="divide-y divide-line">
          {running.map((t) => (
            <Row key={t.id} t={t} needsYou={waiting.has(t.id)} />
          ))}
        </ul>
      )}
      {ended.length > 0 && (
        <details className="mt-4">
          <summary className="min-h-11 py-3 text-[14px] text-ink-2">
            Terminadas ({ended.length})
          </summary>
          <ul className="divide-y divide-line">
            {ended.map((t) => (
              <Row key={t.id} t={t} needsYou={false} />
            ))}
          </ul>
        </details>
      )}
    </main>
  );
}

function Row({ t, needsYou }: { t: TerminalInfo; needsYou: boolean }) {
  const state = terminalState(t, needsYou);
  return (
    <li>
      <Link
        to="/terminal/$id"
        params={{ id: t.id }}
        onClick={() => seen(t.id)}
        className="flex min-h-14 items-center gap-2.5 py-2 text-ink"
      >
        <TerminalMarks t={t} needsYou={needsYou} state={state} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px]">{rowText(t)}</span>
          <span className="block truncate text-[12px] text-ink-2">
            {state} · {shortPath(t.cwd)}
          </span>
        </span>
        {t.ticket && (
          <span className="shrink-0 rounded border border-line px-1.5 font-mono text-[12px] text-ink-2">
            {t.ticket}
          </span>
        )}
      </Link>
    </li>
  );
}
