import { type FormEvent, type Ref, useState } from "react";
import { errorText, InlineError } from "../../ui.tsx";
import type { Tk } from "./desk-tickets.ts";
import { captureTarget, entryLine } from "./journal.ts";
import { appendToNote, useInvalidateMemory } from "./queries.ts";

export function SearchBox({
  q,
  onSearch,
  ref,
}: {
  q: string;
  onSearch: (q: string) => void;
  ref?: Ref<HTMLInputElement>;
}) {
  return (
    <input
      ref={ref}
      type="search"
      aria-label="Buscar en notas y memoria"
      className="btn h-8 w-full shrink-0"
      placeholder="Buscar en notas y memoria  /"
      value={q}
      onChange={(e) => onSearch(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape") e.currentTarget.blur();
      }}
    />
  );
}

// Quick note: one line, written at once. A line naming one of the user's tickets goes to that
// ticket's note, so it is listed under the ticket; any other line goes to today's journal.
export function Capture({ tk, onOpen }: { tk: Tk; onOpen: (id: string) => void }) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<
    { kind: "ok"; text: string; id: string } | { kind: "error"; text: string } | null
  >(null);
  const invalidate = useInvalidateMemory();
  const target = captureTarget(text, tk.projects, (k) => tk.of(k)?.summary, Date.now());
  const where = target.key ? `la nota de ${target.key}` : "el diario de hoy";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim() || pending) return;
    setPending(true);
    setResult(null);
    try {
      const doc = await appendToNote(target.name, target.title, entryLine(Date.now(), text));
      await invalidate();
      setText("");
      setResult({ kind: "ok", text: `Guardado en ${where}.`, id: doc.id });
    } catch (err) {
      setResult({ kind: "error", text: `No se guardó: ${errorText(err)}` });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-1">
      <input
        aria-label="Apunte rápido"
        className="h-9 w-full rounded-md border border-line bg-panel px-3 text-[13px] placeholder:text-ink-2 focus-visible:border-ink-2 focus-visible:outline-none"
        placeholder={
          tk.projects.size > 0
            ? `Apunta algo… con ${[...tk.projects][0]}-123 va a la nota del ticket`
            : "Apunta algo… va al diario de hoy"
        }
        value={text}
        maxLength={500}
        disabled={pending}
        onChange={(e) => {
          setText(e.target.value);
          setResult(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") e.currentTarget.blur();
        }}
      />
      {text.trim() && !result && (
        <p className="px-1 text-[11px] text-ink-2">
          {pending ? "Guardando…" : <>Intro para guardarlo en {where}</>}
        </p>
      )}
      {result?.kind === "ok" && (
        <p role="status" className="flex items-center gap-2 px-1 text-[11px] text-ok">
          {result.text}
          <button type="button" className="btn-ghost text-[11px]" onClick={() => onOpen(result.id)}>
            Abrir
          </button>
        </p>
      )}
      {result?.kind === "error" && (
        <InlineError className="px-1 text-[11px]">{result.text}</InlineError>
      )}
    </form>
  );
}
