import { useMemo, useState } from "react";
import {
  type ItemResult,
  type MailAccount,
  type Proposal,
  type ProposalItem,
  sortPromptId,
} from "../../../shared/mail-sort.ts";
import { useAccess } from "../../access.ts";
import { ApiError } from "../../api.ts";
import { plural, relativeTime } from "../../format.ts";
import { Icon } from "../../icons.tsx";
import { errorText, InlineError, Reconnect } from "../../ui.tsx";
import { createTerminal, useLaunch } from "../terminals/queries.ts";
import { useProposal, useSortActions } from "../today/queries.ts";
import { useEscape } from "../today/thread.tsx";

// The mail categorizer in Inicio: «Categorizar» starts an agent on the column's saved prompt;
// what it proposes is reviewed here, in the centre, and applied only after the user's click in
// AgenticMac's dialog on the Mac (server/features/mail). Nothing is ever sent or deleted for good.

export const ACCOUNT_LABEL: Record<MailAccount, string> = { work: "Trabajo", personal: "Personal" };
const TRASH: Record<MailAccount, string> = { work: "Elementos eliminados", personal: "Papelera" };

export type ProposalGroup = {
  key: string;
  title: string;
  // The folder does not exist yet: applying creates it.
  isNew: boolean;
  items: ProposalItem[];
};

// Folders sort by name; the archive and the trash go last, in that order.
const LAST: Record<string, number> = { archive: 1, trash: 2 };

// One group per folder, by name, then the archive and the trash.
export function proposalGroups(account: MailAccount, items: ProposalItem[]): ProposalGroup[] {
  const groups = new Map<string, ProposalItem[]>();
  for (const item of items) {
    const key = item.op === "move" ? `move:${item.folder ?? ""}` : item.op;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups]
    .sort(([a], [b]) => (LAST[a] ?? 0) - (LAST[b] ?? 0) || a.localeCompare(b))
    .map(([key, items]) => ({
      key,
      title:
        key === "trash"
          ? TRASH[account]
          : key === "archive"
            ? "Archivar (sin etiqueta)"
            : key.slice("move:".length),
      isNew: items.some((i) => i.newFolder),
      items,
    }));
}

const RESULT: Record<ItemResult, [string, string]> = {
  ok: ["ordenado", "ordenados"],
  skipped: ["sin marcar", "sin marcar"],
  gone: ["ya no estaba en la bandeja", "ya no estaban en la bandeja"],
  not_found: ["no encontrado", "no encontrados"],
  no_folder: ["sin carpeta", "sin carpeta"],
  error: ["con error", "con error"],
  unknown: ["salió de la bandeja sin confirmación", "salieron de la bandeja sin confirmación"],
};

// "12 ordenados · 1 con error", in the order RESULT names them.
export function resultLine(items: ProposalItem[]): string {
  const counts = new Map<ItemResult, number>();
  for (const i of items) if (i.result) counts.set(i.result, (counts.get(i.result) ?? 0) + 1);
  return (Object.keys(RESULT) as ItemResult[])
    .flatMap((r) => {
      const n = counts.get(r);
      return n ? [`${n} ${RESULT[r][n === 1 ? 0 : 1]}`] : [];
    })
    .join(" · ");
}

// What a failed apply means; a cancel or a timeout moved nothing.
function applyError(error: unknown): string {
  if (error instanceof ApiError && error.code === "cancelled")
    return "Cancelado en el Mac: no se ha movido nada.";
  if (error instanceof ApiError && error.code === "timeout")
    return "Nadie confirmó en el Mac a tiempo: no se ha movido nada.";
  if (error instanceof ApiError && error.code === "busy")
    return "Ya hay un diálogo abierto en el Mac para esta propuesta.";
  return `No se ha podido aplicar: ${errorText(error)}`;
}

// The column's footer: start the agent, and review what it proposed.
export function SortActions({ account, onReview }: { account: MailAccount; onReview: () => void }) {
  const q = useProposal(account);
  const run = useLaunch();
  const pending = q.data?.proposal;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn text-[12px]"
          disabled={run.pending}
          title="Abre un agente que aprende de tus carpetas y propone dónde va cada correo. No mueve nada."
          onClick={() =>
            run.launch(() =>
              createTerminal("claude", "scratch", { savedPrompt: sortPromptId(account) }),
            )
          }
        >
          {run.pending ? "Abriendo…" : "Categorizar"}
        </button>
        {pending && (
          <button type="button" className="btn btn-primary text-[12px]" onClick={onReview}>
            Revisar propuesta · {pending.items.length}
          </button>
        )}
      </div>
      {q.isError && (
        <InlineError className="text-[12px]">
          No se ha podido leer la propuesta: {errorText(q.error)}
        </InlineError>
      )}
      {run.error && <InlineError className="text-[12px]">{run.error}</InlineError>}
    </div>
  );
}

// The review: every mail ticked at first; the user unticks what stays and applies the rest.
export function ProposalView({ account, onClose }: { account: MailAccount; onClose: () => void }) {
  useEscape(onClose);
  const q = useProposal(account);
  const [done, setDone] = useState<Proposal | null>(null);
  const proposal = done ?? q.data?.proposal ?? null;
  return (
    <article
      aria-labelledby="sort-title"
      className="mx-auto w-full max-w-[760px] px-5 py-5 md:px-8"
    >
      <button type="button" className="btn-ghost -ml-2 text-[12px]" onClick={onClose} title="Esc">
        <Icon name="close" size={12} /> Cerrar
      </button>
      <h1 id="sort-title" className="mt-3 text-[20px] leading-7 font-semibold">
        Ordenar {ACCOUNT_LABEL[account]}
      </h1>
      {q.isPending && !done ? (
        <p className="mt-2 text-[13px] text-ink-2">Leyendo la propuesta…</p>
      ) : q.isError && !done ? (
        <InlineError className="mt-2 text-[13px]">
          No se ha podido leer la propuesta: {errorText(q.error)}
        </InlineError>
      ) : !proposal ? (
        <p className="mt-2 text-[13px] text-ink-2">
          No hay ninguna propuesta pendiente. Pulsa «Categorizar» en la columna{" "}
          {ACCOUNT_LABEL[account]} para que un agente prepare una.
        </p>
      ) : done ? (
        <Applied proposal={done} />
      ) : (
        <Review key={proposal.id} proposal={proposal} onApplied={setDone} onDiscarded={onClose} />
      )}
    </article>
  );
}

function Review({
  proposal,
  onApplied,
  onDiscarded,
}: {
  proposal: Proposal;
  onApplied: (p: Proposal) => void;
  onDiscarded: () => void;
}) {
  const act = useSortActions();
  const access = useAccess();
  const [kept, setKept] = useState(() => new Set(proposal.items.map((i) => i.id)));
  const [busy, setBusy] = useState<"apply" | "discard" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const groups = useMemo(
    () => proposalGroups(proposal.account, proposal.items),
    [proposal.account, proposal.items],
  );
  const remote = access.data?.desktop === false;
  const toggle = (ids: string[], on: boolean) =>
    setKept((k) => {
      const next = new Set(k);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const run = (what: "apply" | "discard") => {
    setBusy(what);
    setError(null);
    (what === "apply"
      ? act.apply(proposal.id, [...kept]).then(({ proposal: p }) => onApplied(p))
      : act.discard(proposal.id).then(onDiscarded)
    )
      .catch(setError)
      .finally(() => setBusy(null));
  };
  const reconnect = error instanceof ApiError && error.code === "reconnect_required";

  return (
    <>
      <p className="mt-1 text-[13px] text-ink-2">
        {plural(proposal.items.length, "correo", "correos")} · propuesta{" "}
        {relativeTime(proposal.createdAt, Date.now())}. Desmarca lo que deba quedarse donde está;
        nada se mueve hasta que lo confirmes en el Mac.
      </p>
      <div className="mt-4 flex flex-col gap-4">
        {groups.map((g) => {
          const ids = g.items.map((i) => i.id);
          const on = ids.filter((id) => kept.has(id)).length;
          return (
            <fieldset key={g.key} className="flex flex-col gap-1">
              <legend className="flex w-full items-center gap-2 px-1 pb-1">
                <input
                  type="checkbox"
                  aria-label={`Todos en ${g.title}`}
                  checked={on === ids.length}
                  ref={(el) => {
                    if (el) el.indeterminate = on > 0 && on < ids.length;
                  }}
                  onChange={(e) => toggle(ids, e.target.checked)}
                />
                <span className="text-[14px] font-semibold">→ {g.title}</span>
                {g.isNew && <span className="pill">carpeta nueva</span>}
                <span className="text-[12px] text-ink-2 tabular-nums">
                  {on} de {ids.length}
                </span>
              </legend>
              {g.items.map((i) => (
                <label
                  key={i.id}
                  className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--selected)]"
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={kept.has(i.id)}
                    onChange={(e) => toggle([i.id], e.target.checked)}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex gap-2 text-[13px]">
                      <span className="shrink-0 font-medium">{i.from || "(sin remitente)"}</span>
                      <span className="min-w-0 truncate">{i.subject ?? "(sin asunto)"}</span>
                    </span>
                    <span className="text-[12px] text-ink-2">{i.reason}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          );
        })}
      </div>
      <div className="sticky bottom-0 mt-4 flex flex-wrap items-center gap-2 border-t border-line bg-bg py-3">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy !== null || kept.size === 0 || remote}
          onClick={() => run("apply")}
        >
          {busy === "apply" ? "Confirma en el Mac…" : `Aplicar ${kept.size}`}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy !== null}
          onClick={() => run("discard")}
        >
          Descartar
        </button>
        <span className="text-[12px] text-ink-2">
          {remote
            ? "Se aplica desde el Mac: el diálogo de confirmación sale en su pantalla."
            : "Saldrá un diálogo en el Mac para confirmar. No se envía ni se borra nada para siempre."}
        </span>
      </div>
      {error !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <InlineError className="text-[13px]">
            {reconnect
              ? "Google necesita el permiso para ordenar Gmail: reconéctalo y vuelve a aplicar."
              : applyError(error)}
          </InlineError>
          {reconnect && (
            <Reconnect provider="google" className="btn text-[12px]">
              Reconectar Google
            </Reconnect>
          )}
        </div>
      )}
    </>
  );
}

function Applied({ proposal }: { proposal: Proposal }) {
  const failed = proposal.items.filter((i) => i.result && !["ok", "skipped"].includes(i.result));
  return (
    <div className="mt-2 flex flex-col gap-3">
      <p role="status" className="text-[13px]">
        Aplicada: {resultLine(proposal.items)}.
      </p>
      {failed.length > 0 && (
        <ul className="flex flex-col gap-1">
          {failed.map((i) => (
            <li key={i.id} className="text-[13px]">
              <span className="font-medium">{i.from || "(sin remitente)"}</span>{" "}
              {i.subject ?? "(sin asunto)"}{" "}
              <span className="text-ink-2">· {RESULT[i.result as ItemResult][0]}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
