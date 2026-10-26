import { type ReactNode, useState } from "react";
import { copyText } from "../../clipboard.ts";
import { ErrorState, InlineError, SkeletonRows } from "../../ui.tsx";
import { type HeaderDrag, TileHeader } from "../terminals/tile-header.tsx";
import { type ProposalView, useProposals, useRecording, useRecordingActions } from "./queries.ts";

// A recorded meeting as a Mesa tile: how the capture goes while the call lasts, then what the
// review agent proposes (accepted or discarded here, one by one), the voices to name and the
// text. The server puts it in the «Sistema» block when a recording starts.

const STATUS: Record<string, string> = {
  recording: "Grabando",
  transcribing: "Transcribiendo",
  diarizing: "Separando voces",
  ready: "Lista",
  failed: "Fallida",
};
const WARNING: Record<string, string> = {
  mic_silent: "El micro apenas recibe voz: si hablas y sigue, revisa el micro de Teams.",
  system_silent: "No llega audio de la llamada.",
};
const KIND: { kind: ProposalView["kind"]; title: string }[] = [
  { kind: "action", title: "Acciones" },
  { kind: "decision", title: "Acuerdos" },
  { kind: "memory", title: "Para recordar" },
];
const WHERE: Record<ProposalView["kind"], string> = {
  action: "tarea creada",
  decision: "en la nota, Acuerdos",
  memory: "en la nota, Para recordar",
};

const pad = (n: number) => String(Math.floor(n)).padStart(2, "0");
export const clock = (s: number) =>
  s >= 3600
    ? `${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}`
    : `${pad(s / 60)}:${pad(s % 60)}`;
export const who = (speaker: string) =>
  speaker === "me" ? "Yo" : speaker === "others" ? "Otros" : speaker;
const when = (iso: string) =>
  new Date(iso).toLocaleString("es-ES", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

export function RecView({
  recording,
  lead,
  actions,
  drag,
}: {
  recording: string | null;
  lead?: ReactNode;
  actions?: ReactNode;
  drag?: HeaderDrag;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-panel text-ink">
      {recording ? (
        <Recording id={recording} lead={lead} actions={actions} drag={drag} />
      ) : (
        <>
          <TileHeader lead={lead} harness="rec" chip="Reunión" label="?" drag={drag}>
            {actions}
          </TileHeader>
          <p className="px-4 py-3 text-[12px] text-ink-2">
            Esta tile no dice de qué grabación es: quítala de la Mesa.
          </p>
        </>
      )}
    </div>
  );
}

function Recording({
  id,
  lead,
  actions,
  drag,
}: {
  id: string;
  lead?: ReactNode;
  actions?: ReactNode;
  drag?: HeaderDrag;
}) {
  const q = useRecording(id);
  const t = q.data?.transcript;
  const act = useRecordingActions(id);
  const header = (
    <TileHeader
      lead={lead}
      harness="rec"
      chip="Reunión"
      label={t ? `Llamada · ${when(t.createdAt)}` : "Llamada"}
      drag={drag}
    >
      {t && (
        <span className="shrink-0 text-white/55" data-rec-status={t.status}>
          {STATUS[t.status] ?? t.status}
        </span>
      )}
      {t?.status === "recording" && (
        <button
          type="button"
          className="btn-ghost text-[12px] text-term-ink"
          disabled={act.stop.isPending}
          onClick={() => act.stop.mutate()}
        >
          Parar
        </button>
      )}
      {actions}
    </TileHeader>
  );
  if (q.isPending)
    return (
      <>
        {header}
        <SkeletonRows count={3} />
      </>
    );
  if (q.isError || !t)
    return (
      <>
        {header}
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </>
    );
  const { done, total } = t.progress;
  return (
    <>
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-[12px]">
        {act.stop.isError && <InlineError>{act.stop.error.message}</InlineError>}
        {t.status === "failed" ? (
          <InlineError>{t.error ?? "La grabación falló."}</InlineError>
        ) : t.status !== "ready" ? (
          <p className="text-ink-2">
            {total > 0
              ? `${done} de ${total} bloques de cinco minutos transcritos.`
              : "El primer bloque se transcribe a los cinco minutos."}
            {t.status === "diarizing" && " Separando las voces de la llamada."}
          </p>
        ) : null}
        {t.warnings.map((w) => (
          <p key={w} className="text-warn">
            {WARNING[w] ?? w}
          </p>
        ))}
        {t.status === "ready" && <Review id={id} />}
        {t.status === "ready" && t.labels.some((l) => l !== "me") && (
          <Voices labels={t.labels} names={t.names} onSave={(n) => act.names.mutate(n)} />
        )}
        {act.names.isError && <InlineError>{act.names.error.message}</InlineError>}
        <Text segments={t.segments} markdown={t.markdown} />
      </div>
    </>
  );
}

function Review({ id }: { id: string }) {
  const q = useProposals(id);
  const act = useRecordingActions(id);
  const again = (
    <button
      type="button"
      className="btn-ghost text-[12px]"
      disabled={act.review.isPending}
      onClick={() => act.review.mutate()}
    >
      Revisar otra vez
    </button>
  );
  if (q.isPending) return <SkeletonRows count={2} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const p = q.data.proposals;
  return (
    <section aria-label="Propuestas" className="mb-3">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 font-semibold text-ink">Propuestas</h3>
        {again}
      </div>
      {act.review.isError && <InlineError>{act.review.error.message}</InlineError>}
      {act.decide.isError && <InlineError>{act.decide.error.message}</InlineError>}
      {!p ? (
        <p className="text-ink-2">
          Un agente lee la transcripción en la Mesa «Reuniones» del bloque Sistema. Sus propuestas
          salen aquí; si lo cierras antes, «Revisar otra vez».
        </p>
      ) : (
        <>
          {p.summary && <p className="my-1 text-ink-2">{p.summary}</p>}
          {p.items.length === 0 && <p className="text-ink-2">El agente no vio nada que guardar.</p>}
          {KIND.map(({ kind, title }) => {
            const items = p.items.filter((i) => i.kind === kind);
            if (items.length === 0) return null;
            return (
              <div key={kind} className="mt-2">
                <h4 className="text-ink-2">{title}</h4>
                <ul className="mt-1 flex flex-col gap-1">
                  {items.map((item) => (
                    <Proposal
                      key={item.id}
                      item={item}
                      busy={act.decide.isPending}
                      onDecide={(state, text) => act.decide.mutate({ item: item.id, state, text })}
                    />
                  ))}
                </ul>
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}

function Proposal({
  item,
  busy,
  onDecide,
}: {
  item: ProposalView;
  busy: boolean;
  onDecide: (state: "accepted" | "discarded", text?: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const decided = item.decision;
  const meta = [
    item.owner,
    item.dueOn && `para el ${item.dueOn}`,
    item.at != null && `min ${clock(item.at)}`,
  ].filter(Boolean);
  return (
    <li
      className={`rounded border border-line px-2 py-1 ${decided ? "opacity-60" : ""}`}
      data-proposal={item.kind}
    >
      {draft === null ? (
        <p className={decided?.state === "discarded" ? "line-through" : ""}>
          {decided?.text ?? item.text}
        </p>
      ) : (
        <textarea
          aria-label="Texto de la propuesta"
          className="w-full rounded border border-line bg-panel p-1"
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      )}
      <div className="flex flex-wrap items-center gap-1 text-ink-2">
        <span className="flex-1">{meta.join(" · ")}</span>
        {decided ? (
          <span>
            {decided.state === "accepted" ? `Aceptada: ${WHERE[item.kind]}` : "Descartada"}
          </span>
        ) : (
          <>
            {draft === null && (
              <button type="button" className="btn-ghost" onClick={() => setDraft(item.text)}>
                Editar
              </button>
            )}
            <button
              type="button"
              className="btn-ghost"
              disabled={busy}
              onClick={() => onDecide("discarded")}
            >
              Descartar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || draft?.trim() === ""}
              onClick={() => onDecide("accepted", draft?.trim() || undefined)}
            >
              Aceptar
            </button>
          </>
        )}
      </div>
    </li>
  );
}

// The diarizer's labels, named by the user; an empty name takes the label back.
function Voices({
  labels,
  names,
  onSave,
}: {
  labels: string[];
  names: Record<string, string>;
  onSave: (names: Record<string, string>) => void;
}) {
  return (
    <section aria-label="Voces" className="mb-3">
      <h3 className="font-semibold text-ink">Voces</h3>
      <div className="mt-1 flex flex-wrap gap-2">
        {labels
          .filter((l) => l !== "me")
          .map((label) => (
            <label key={label} className="flex items-center gap-1 text-ink-2">
              {label}
              <input
                className="w-32 rounded border border-line bg-panel px-1 text-ink"
                defaultValue={names[label] ?? ""}
                placeholder="Nombre"
                onBlur={(e) => {
                  const value = e.target.value.trim();
                  if (value !== (names[label] ?? "")) onSave({ ...names, [label]: value });
                }}
              />
            </label>
          ))}
      </div>
    </section>
  );
}

function Text({
  segments,
  markdown,
}: {
  segments: { start: number; speaker: string; text: string }[];
  markdown: string;
}) {
  const [copied, setCopied] = useState(false);
  if (segments.length === 0) return null;
  return (
    <section aria-label="Transcripción">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 font-semibold text-ink">Transcripción</h3>
        <button
          type="button"
          className="btn-ghost text-[12px]"
          onClick={() => copyText(markdown).then(() => setCopied(true))}
        >
          {copied ? "Copiada" : "Copiar"}
        </button>
      </div>
      <ol className="mt-1 flex flex-col gap-0.5">
        {segments.map((s) => (
          <li key={`${s.start}-${s.speaker}`} className="flex gap-2">
            <span className="shrink-0 font-mono text-ink-2">{clock(s.start)}</span>
            <span className="shrink-0 font-semibold">{who(s.speaker)}</span>
            <span>{s.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
