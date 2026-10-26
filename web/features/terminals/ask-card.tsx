import { useQuery } from "@tanstack/react-query";
import { ScreenText } from "../../../shared/host-contract.ts";
import type { TerminalKey } from "../../../shared/terminals.ts";
import { api, unwrap } from "../../api.ts";
import { pollEvery } from "../../poll.ts";
import { errorText } from "../../ui.tsx";
import { keepFocus } from "./mobile.tsx";

export const ASK_POLL_MS = 1500;
// Enough for a permission prompt or a menu of choices with its question.
const ASK_LINES = 12;
const ASK_KEYS: [string, TerminalKey][] = [
  ["↑", "up"],
  ["↓", "down"],
  ["Enter", "enter"],
  ["Esc", "esc"],
];

// While the agent asks (a permission, a menu), the phone shows what it asks as the terminal
// draws it and the keys that answer, without holding the terminal: the text is read through
// the server, the keys go through /send. Shown only while it asks.
export function AskCard({ id, press }: { id: string; press: (key: TerminalKey) => void }) {
  const q = useQuery({
    queryKey: ["terminal-text", id],
    queryFn: async () =>
      ScreenText.parse(await unwrap(await api.api.terminals[":id"].text.$get({ param: { id } }))),
    refetchInterval: pollEvery(ASK_POLL_MS),
  });
  const lines = q.data?.text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-ASK_LINES);
  return (
    <section aria-label="El agente pregunta" className="border-b border-white/10 bg-term-ask/60">
      {q.error ? (
        <p role="alert" className="px-3 py-2 text-[13px] text-bad">
          No se ha podido leer la terminal: {errorText(q.error)}.
        </p>
      ) : (
        <pre className="max-h-[40dvh] overflow-auto px-3 py-2 font-mono text-[12px] leading-snug whitespace-pre-wrap break-words text-white/90">
          {lines ? lines.join("\n") : "Leyendo la terminal…"}
        </pre>
      )}
      <div className="grid grid-cols-4 gap-1.5 px-2 pb-2">
        {ASK_KEYS.map(([label, key]) => (
          <button
            key={key}
            type="button"
            className="btn min-h-11 justify-center font-medium"
            onPointerDown={keepFocus}
            onClick={() => press(key)}
          >
            {label}
          </button>
        ))}
      </div>
    </section>
  );
}
