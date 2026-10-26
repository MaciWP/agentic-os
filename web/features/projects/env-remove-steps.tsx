import { type FormEvent, type ReactNode, useState } from "react";
import { Icon } from "../../icons.tsx";
import type { RemovePreview } from "./env-jobs.ts";
import { Failure } from "./job-output.tsx";

// Removing an env takes up to three steps in a modal: ¿Borrar?, what would be lost (only when
// something would), and a last call ticked before the red button. Work is never lost
// silently: the server removes it only if the provider still reports exactly what was shown.
export type RemoveStep = "intro" | "losses" | "last";
const STEP_TITLE: Record<RemoveStep, string> = {
  intro: "¿Borrar el entorno?",
  losses: "Lo que se pierde",
  last: "Último aviso",
};

export function Stepper({ steps, current }: { steps: RemoveStep[]; current: RemoveStep }) {
  const at = steps.indexOf(current);
  return (
    <div className="space-y-1.5">
      <ol aria-label="Pasos" className="flex items-center">
        {steps.map((s, i) => (
          <li
            key={s}
            aria-current={i === at ? "step" : undefined}
            aria-label={`Paso ${i + 1}: ${STEP_TITLE[s]}`}
            className="flex items-center"
          >
            {i > 0 && <span className={`h-px w-8 ${i <= at ? "bg-primary" : "bg-line"}`} />}
            <span
              className={`grid size-5 place-items-center rounded-full border text-[10px] font-semibold ${
                i < at
                  ? "border-primary bg-primary text-[var(--on-accent)]"
                  : i === at
                    ? s === "last"
                      ? "border-bad text-bad"
                      : "border-primary text-primary"
                    : "border-line text-ink-2"
              }`}
            >
              {i < at ? <Icon name="check" size={12} /> : i + 1}
            </span>
          </li>
        ))}
      </ol>
      <p className="text-[11px] text-ink-2">
        Paso {at + 1} de {steps.length} · {STEP_TITLE[current]}
      </p>
    </div>
  );
}

// One porcelain line as a word and a path: "?? reports/" → nuevo · reports/. A submodule's
// own lines carry its name first ("contract:  M x"); anything else shows as it came.
const STATUS_WORD: [RegExp, string][] = [
  [/\?\?/, "nuevo"],
  [/D/, "borrado"],
  [/A/, "añadido"],
  [/R/, "renombrado"],
  [/U/, "en conflicto"],
  [/M/, "modificado"],
];
export function porcelain(line: string): { word: string | null; path: string } {
  const m = /^(?:(\S+): )?([ MADRCU?!]{2}) (.+)$/.exec(line);
  if (!m) return { word: null, path: line.trim() };
  const [, sub, code = "", path = ""] = m;
  const word = STATUS_WORD.find(([re]) => re.test(code))?.[1] ?? code.trim();
  return { word, path: sub ? `${sub}/${path.trim()}` : path.trim() };
}

const count = (r: Record<string, string[]>) =>
  Object.values(r).reduce((n, lines) => n + lines.length, 0);

function LossGroup({
  title,
  tone,
  byRepo,
  commits,
}: {
  title: string;
  tone: "bad" | "warn";
  byRepo: Record<string, string[]>;
  commits?: boolean;
}) {
  const repos = Object.entries(byRepo);
  if (repos.length === 0) return null;
  return (
    <section aria-label={title} className="space-y-1.5">
      <h4 className={`font-medium ${tone === "bad" ? "text-bad" : "text-warn"}`}>
        {title} · {count(byRepo)}
      </h4>
      {repos.map(([repo, lines]) => (
        <div key={repo} className="rounded-md border border-line bg-bg">
          <p className="border-b border-line px-2 py-1 font-mono text-[11px] text-ink-2">{repo}</p>
          <ul className="max-h-48 overflow-auto px-2 py-1 font-mono text-[11px]">
            {lines.map((l) => {
              const { word, path } = commits ? { word: "commit", path: l.trim() } : porcelain(l);
              return (
                <li key={l} className="flex gap-2 py-0.5" title={l}>
                  <span className={`w-20 shrink-0 ${tone === "bad" ? "text-bad" : "text-warn"}`}>
                    {word ?? ""}
                  </span>
                  <span className="min-w-0 truncate">{path}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return <div className="flex justify-end gap-2 border-t border-line pt-3">{children}</div>;
}

export function RemoveIntro({
  name,
  checking,
  error,
  onRecheck,
  onCancel,
  onNext,
}: {
  name: string;
  checking: boolean;
  error: string | null;
  onRecheck: () => void;
  onCancel: () => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-3">
      <p>
        Se borran los checkouts de <span className="font-mono">{name}</span> y sus datos de Docker.
        Las ramas de git se quedan. Las terminales abiertas dentro del entorno se cierran al borrar.
      </p>
      {checking && (
        <p className="text-ink-2">Comprobando qué se perdería… En frío tarda unos segundos.</p>
      )}
      {error && (
        <div className="space-y-2">
          <Failure error={`No se pudo comprobar: ${error}`} />
          <button type="button" className="btn" onClick={onRecheck}>
            Volver a comprobar
          </button>
        </div>
      )}
      <Footer>
        <button type="button" className="btn" onClick={onCancel}>
          Cancelar
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={checking || Boolean(error)}
          onClick={onNext}
        >
          Sí, continuar
        </button>
      </Footer>
    </div>
  );
}

export function RemoveLosses({
  preview: p,
  onBack,
  onNext,
}: {
  preview: RemovePreview;
  onBack: () => void;
  onNext: () => void;
}) {
  const [reviewed, setReviewed] = useState(false);
  const total = count(p.dirty) + count(p.unpublished);
  return (
    <div className="space-y-3">
      <p className="flex items-start gap-2 rounded-md border border-warn/50 bg-warn/10 p-2 text-warn">
        <Icon name="warning" size={14} />
        <span>
          Hay {total === 1 ? "1 cambio pendiente" : `${total} cambios pendientes`}. Si borras, se
          pierden.
          {p.recoverableOnly &&
            " Solo son punteros de submódulo movidos; sus commits siguen en el clon del submódulo."}
        </span>
      </p>
      <LossGroup
        title="Commits que no están en ningún remoto"
        tone="bad"
        byRepo={p.unpublished}
        commits
      />
      <LossGroup title="Cambios sin commit" tone="warn" byRepo={p.dirty} />
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />
        He revisado{" "}
        {total === 1 ? "el cambio que se pierde" : `los ${total} cambios que se pierden`}
      </label>
      <Footer>
        <button type="button" className="btn" onClick={onBack}>
          Atrás
        </button>
        <button type="button" className="btn btn-primary" disabled={!reviewed} onClick={onNext}>
          Sí, continuar
        </button>
      </Footer>
    </div>
  );
}

// The terminals the remove closes, named so the user can spot work still running in one.
function ClosingTerminals({ open }: { open: RemovePreview["open"] }) {
  if (open.length === 0) return null;
  return (
    <div className="space-y-1 rounded-md border border-warn/50 bg-warn/10 p-2 text-warn">
      <p className="flex items-center gap-2">
        <Icon name="warning" size={14} />
        {open.length === 1
          ? "Se cierra 1 terminal abierta. Mira que no tenga nada a medias:"
          : `Se cierran ${open.length} terminales abiertas. Mira que no tengan nada a medias:`}
      </p>
      <ul className="ml-6 list-disc">
        {open.map((t) => (
          <li key={t.id}>
            «{t.name}» en <span className="font-mono">{t.folder}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RemoveLastCall({
  name,
  preview: p,
  pending,
  error,
  onBack,
  onRecheck,
  onRemove,
}: {
  name: string;
  preview: RemovePreview;
  pending: boolean;
  error: string | null;
  onBack: () => void;
  onRecheck: () => void;
  onRemove: () => void;
}) {
  const [sure, setSure] = useState(false);
  const total = count(p.dirty) + count(p.unpublished);
  const repos = [...new Set([...Object.keys(p.unpublished), ...Object.keys(p.dirty)])];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (sure && !pending) onRemove();
  };
  return (
    <form onSubmit={submit} aria-label="Borrar entorno" className="space-y-3">
      <div className="space-y-1 rounded-md border border-bad/40 bg-bad/5 p-3">
        <p className="flex items-center gap-2 font-semibold text-bad">
          <Icon name="warning" size={14} />
          Esto no se puede deshacer
        </p>
        <p>
          {total === 0
            ? "No se pierde trabajo: no hay cambios sin commit ni commits sin subir."
            : `Se pierden ${total === 1 ? "1 cambio" : `${total} cambios`} en ${repos.join(", ")}.`}
        </p>
      </div>
      <ClosingTerminals open={p.open} />
      {p.warnings.map((w) => (
        <p key={w} className="text-warn">
          {w}
        </p>
      ))}
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
        <span>
          Sí, borrar <span className="font-mono">{name}</span>
          {total > 0 && " y perder estos cambios"}
        </span>
      </label>
      {error && (
        <div className="space-y-2">
          <Failure error={error} />
          <button type="button" className="btn" onClick={onRecheck}>
            Volver a revisar
          </button>
        </div>
      )}
      <Footer>
        <button type="button" className="btn" onClick={onBack}>
          Atrás
        </button>
        <button type="submit" className="btn btn-danger gap-1.5" disabled={!sure || pending}>
          <Icon name="trash" size={13} />
          {pending ? "Comprobando y borrando…" : `Borrar ${name}`}
        </button>
      </Footer>
    </form>
  );
}
