import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { errorText, InlineError } from "../../ui.tsx";
import { createDoc, type SourceId, snippetParts, useInvalidateMemory } from "./queries.ts";

export const SOURCE_LABEL: Record<SourceId, string> = {
  notes: "Nota",
  memory: "Memoria de la app",
  prompts: "Prompt",
  "claude-memory": "Claude Code · memoria",
  "claude-md": "Claude Code · CLAUDE.md",
  codex: "Codex",
  grok: "Grok",
};

// Creates an empty document and opens it: on its own page, or through `onCreated`.
export function NewDoc({
  sources,
  onDone,
  onCreated,
}: {
  sources: SourceId[];
  onDone: () => void;
  onCreated?: (id: string) => void;
}) {
  const [source, setSource] = useState(sources[0] as SourceId);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const navigate = useNavigate();
  const invalidate = useInvalidateMemory();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const { doc } = await createDoc(source, name, `# ${name.trim()}\n\n`);
      await invalidate();
      onDone();
      if (onCreated) onCreated(doc.id);
      else await navigate({ to: "/docs", search: { id: doc.id } });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2 px-4 pb-3">
      <div className="flex gap-2">
        {sources.length > 1 && (
          <select
            aria-label="Dónde"
            className="btn"
            value={source}
            onChange={(e) => setSource(e.target.value as SourceId)}
          >
            {sources.map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABEL[s]}
              </option>
            ))}
          </select>
        )}
        <input
          aria-label="Nombre"
          className="btn min-w-0 flex-1"
          placeholder="Nombre"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          // biome-ignore lint/a11y/noAutofocus: the form opens on an explicit click
          autoFocus
        />
      </div>
      {error && <InlineError className="text-[12px]">{error}</InlineError>}
      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary" disabled={pending || !name.trim()}>
          {pending ? "Creando…" : "Crear"}
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

// A search hit's snippet with the matched words marked.
export function Snippet({ text }: { text: string }) {
  return (
    <>
      {snippetParts(text).map((p, i) =>
        p.mark ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed string
          <mark key={i} className="rounded-sm bg-primary/20 text-ink">
            {p.text}
          </mark>
        ) : (
          p.text
        ),
      )}
    </>
  );
}
