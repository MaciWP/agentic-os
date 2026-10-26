import { type KeyboardEvent, useState } from "react";
import { shortcut } from "../../keys.ts";
import { InlineError } from "../../ui.tsx";
import { gitErrorText, useCommit } from "./queries.ts";

export function CommitBox({
  location,
  stagedCount,
  conflicts,
}: {
  location: string;
  stagedCount: number;
  conflicts: number;
}) {
  const [message, setMessage] = useState("");
  const commit = useCommit(location);
  const why = conflicts
    ? "Resuelve los conflictos antes del commit."
    : stagedCount === 0
      ? "Prepara ficheros para el commit."
      : !message.trim()
        ? "Escribe el mensaje del commit."
        : null;
  const submit = () => {
    if (why || commit.isPending) return;
    commit.mutate(message, { onSuccess: () => setMessage("") });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };
  return (
    <form
      aria-label="Commit"
      className="shrink-0 space-y-2 border-t border-line p-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        aria-label="Mensaje del commit"
        className="block h-20 w-full resize-y rounded-md border border-line bg-bg px-2 py-1.5 font-mono text-[12px] text-ink placeholder:text-ink-2 focus:border-primary focus:outline-none"
        placeholder={`Mensaje del commit (${shortcut("↵")} para hacerlo)`}
        value={message}
        maxLength={10_000}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="flex items-center gap-2">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={Boolean(why) || commit.isPending}
          title={why ?? "Hace el commit de lo preparado; los hooks del repo se ejecutan"}
        >
          {commit.isPending ? "Haciendo commit…" : `Commit (${stagedCount})`}
        </button>
        {why && stagedCount === 0 && !conflicts && (
          <span className="text-[12px] text-ink-2">{why}</span>
        )}
      </div>
      {commit.error ? (
        <InlineError className="whitespace-pre-wrap text-[12px]">
          {gitErrorText(commit.error)}
        </InlineError>
      ) : (
        commit.data && (
          <p role="status" className="text-[12px] text-ink-2">
            Commit <span className="font-mono">{commit.data.oid.slice(0, 7)}</span>:{" "}
            {commit.data.summary}
          </p>
        )
      )}
    </form>
  );
}
