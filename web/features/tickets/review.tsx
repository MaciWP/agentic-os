import { cn } from "cn";
import { useState } from "react";
import type { Pr } from "../../../server/features/github/prs.ts";
import type { Ticket } from "../../../server/features/jira/issues.ts";
import { InlineError } from "../../ui.tsx";
import { jiraStep, prStep, type ReviewStep, type StepState, useTakeReview } from "./queries.ts";

const names = (people: { displayName: string }[]) => people.map((p) => p.displayName).join(", ");

// Why a PR takes no review request: it was asked of the user already, or the user wrote it.
const PR_NOTE: Partial<Record<Pr["kind"], string>> = {
  review: "ya te la han pedido",
  mine: "es tuyo",
};

const STEP_TEXT: Record<StepState["state"], string> = {
  running: "en curso…",
  ok: "hecho",
  failed: "falló",
};

// A teammate's ticket: who owns it, who reviews it, its PRs, and «Revisar yo». That adds the
// user to the ticket's reviewers in Jira and asks for their review on each PR that names the
// ticket; whoever reviews it already stays. Each write stands alone: one that fails is shown
// with its reason and its own retry, and the ones that went through are kept.
// `prGap` says why the PR list may be short: "loading", "off" (GitHub not set up) or GitHub's
// error. Null means it is whole.
export function Review({
  t,
  me,
  prs,
  prGap,
}: {
  t: Ticket;
  me: string | null;
  prs: Pr[];
  prGap: string | null;
}) {
  const take = useTakeReview(t.key);
  const [asking, setAsking] = useState(false);
  const [ran, setRan] = useState<ReviewStep[]>([]);
  const loading = prGap === "loading";
  const unread = prGap !== null && !loading && prGap !== "off";
  const inJira = me !== null && t.reviewers.some((r) => r.accountId === me);
  const others = t.reviewers.filter((r) => r.accountId !== me);
  const steps = [
    ...(inJira ? [] : [jiraStep(t.key)]),
    ...prs.filter((p) => !PR_NOTE[p.kind]).map((p) => prStep(p.repo, p.number)),
  ];
  // Steps not sent yet: all of them at first, then a PR whose list arrived after the first run.
  const pending = steps.filter((s) => !ran.some((r) => r.id === s.id));
  const failed = ran.filter((s) => take.steps[s.id]?.state === "failed");

  const confirm = () => {
    setAsking(false);
    setRan((now) => [...now, ...pending]);
    void take.run(pending);
  };

  return (
    <div className="flex flex-col gap-2.5 text-[12px]">
      <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        <dt className="text-ink-2">Responsable</dt>
        <dd className="truncate">{t.assignee?.displayName ?? "Sin asignar"}</dd>
        <dt className="text-ink-2">Revisores</dt>
        <dd className={cn("min-w-0", t.reviewers.length === 0 && "text-warn")}>
          {t.reviewers.length === 0
            ? "Nadie todavía"
            : [...(inJira ? ["Tú"] : []), ...others.map((r) => r.displayName)].join(", ")}
        </dd>
        <dt className="text-ink-2">PR</dt>
        <dd className="flex min-w-0 flex-col gap-1">
          {loading && <span className="text-ink-2">Cargando PRs…</span>}
          {prGap === "off" && <span className="text-ink-2">GitHub no está configurado</span>}
          {unread && <span className="text-warn">No se leyeron todos los PRs: {prGap}</span>}
          {prGap === null && prs.length === 0 && (
            <span className="text-ink-2">Ningún PR abierto nombra el ticket</span>
          )}
          {prs.map((p) => (
            <span key={`${p.repo}#${p.number}`} className="flex min-w-0 items-center gap-2">
              <a
                href={p.url}
                target="_blank"
                rel="noreferrer noopener"
                className="truncate font-mono hover:underline"
                title={p.title}
              >
                {p.repo}#{p.number} ↗
              </a>
              {p.draft && <span className="pill shrink-0">borrador</span>}
              {PR_NOTE[p.kind] && <span className="shrink-0 text-ink-2">{PR_NOTE[p.kind]}</span>}
            </span>
          ))}
        </dd>
      </dl>

      {steps.length === 0 && ran.length === 0 && (
        <p className="text-ink-2">Ya revisas este ticket en Jira y en sus PRs.</p>
      )}
      {pending.length > 0 && !asking && (
        <button
          type="button"
          className="btn btn-primary self-start"
          disabled={loading || take.running}
          onClick={() => setAsking(true)}
        >
          Revisar yo
        </button>
      )}

      {asking && (
        <fieldset className="flex flex-col gap-2 rounded-md border border-line p-3">
          <legend className="px-1 font-medium">Pasas a revisar {t.key}</legend>
          <ul className="flex list-disc flex-col gap-1 pl-4">
            {pending.map((s) =>
              s.id === "jira" ? (
                <li key={s.id}>
                  En Jira te añade a los revisores
                  {others.length > 0 ? `; ${names(others)} siguen.` : "."}
                </li>
              ) : (
                <li key={s.id}>
                  En GitHub pide tu revisión en <span className="font-mono">{s.id}</span>; sus
                  revisores siguen.
                </li>
              ),
            )}
            {unread && (
              <li className="text-warn">
                Los PRs que no se leyeron no reciben tu petición; vuelve cuando GitHub responda.
              </li>
            )}
          </ul>
          <span className="flex gap-2">
            <button type="button" className="btn btn-primary" onClick={confirm}>
              Confirmar
            </button>
            <button type="button" className="btn" onClick={() => setAsking(false)}>
              Cancelar
            </button>
          </span>
        </fieldset>
      )}

      {ran.length > 0 && (
        <ul aria-label="Revisión" className="flex flex-col gap-1">
          {ran.map((s) => {
            const st = take.steps[s.id];
            return (
              <li key={s.id} className="flex min-w-0 flex-wrap items-center gap-x-2">
                <span>{s.label}</span>
                {st && (
                  <span
                    className={cn(
                      st.state === "ok" && "text-ok",
                      st.state === "failed" && "text-bad",
                      st.state === "running" && "text-ink-2",
                    )}
                  >
                    {STEP_TEXT[st.state]}
                  </span>
                )}
                {st?.state === "failed" && (
                  <>
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={take.running}
                      onClick={() => void take.run([s])}
                    >
                      Reintentar
                    </button>
                    <span className="basis-full text-bad">{st.error}</span>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {failed.length > 0 && !take.running && (
        <InlineError>
          No se hizo todo: {failed.map((s) => s.label).join(" y ")}. Lo que sí se hizo se queda.
        </InlineError>
      )}
    </div>
  );
}
