import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, unwrap } from "../../api.ts";
import { copyText } from "../../clipboard.ts";
import { ErrorState, errorText, InlineError, Modal, SkeletonRows } from "../../ui.tsx";
import { bringLabel } from "./bring.ts";

// A ticket or a PR whose context can be copied.
export type ContextItem = { ticket: string } | { pr: { repo: string; number: number } };

const query = (item: ContextItem) =>
  "ticket" in item
    ? { ticket: item.ticket }
    : { repo: item.pr.repo, number: String(item.pr.number) };

// «Copiar contexto»: the text "Llevar a…" gives an agent (the item and its discussion, no
// instruction), shown to read and copied to paste anywhere, inside the Mesa or out of it.
export function ContextDialog({ item, onClose }: { item: ContextItem; onClose: () => void }) {
  const label = bringLabel(item);
  const read = useQuery({
    queryKey: ["context", query(item)],
    queryFn: async () => unwrap(await api.api.terminals.context.$get({ query: query(item) })),
    // Read once per opening: Jira and GitHub change under it.
    gcTime: 0,
    retry: false,
  });
  const [copied, setCopied] = useState<{ ok: boolean; text: string } | null>(null);
  const copy = (text: string) =>
    copyText(text).then(
      () => setCopied({ ok: true, text: "Copiado. Pégalo donde quieras." }),
      (err) => setCopied({ ok: false, text: `No se ha copiado: ${errorText(err)}.` }),
    );
  return (
    <Modal title={`Contexto de ${label}`} onClose={onClose}>
      {read.isPending ? (
        <SkeletonRows count={4} />
      ) : read.isError ? (
        <ErrorState error={read.error} onRetry={() => read.refetch()} />
      ) : (
        <div className="flex min-h-0 flex-col gap-2 p-3">
          <textarea
            readOnly
            aria-label={`Contexto de ${label}`}
            value={read.data.text}
            className="h-80 w-full resize-none rounded border border-line bg-[var(--hover)] p-2 font-mono text-[11px] leading-snug"
          />
          <div className="flex items-center gap-2">
            {copied &&
              (copied.ok ? (
                <p role="status" className="text-[12px] text-ink-2">
                  {copied.text}
                </p>
              ) : (
                <InlineError className="text-[12px]">{copied.text}</InlineError>
              ))}
            <button
              type="button"
              className="btn ml-auto"
              data-autofocus
              onClick={() => void copy(read.data.text)}
            >
              Copiar
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
