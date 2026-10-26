import { errorText } from "../../ui.tsx";
import { Row, Section } from "../system/panel-rows.tsx";
import { type Ai, type AiAction, type AiState, useAi, useAiAction } from "./queries.ts";

const STATE_LABEL: Record<AiState["state"], string> = {
  off: "Apagado",
  starting: "Arrancando…",
  ready: "Listo",
  failed: "Ha fallado",
};

export function engineText(s: AiState): string {
  if (s.gameMode) return "Modo juego: no arranca";
  if (s.state === "ready" && s.inFlight > 0) return `Trabajando (${s.inFlight} en curso)`;
  return STATE_LABEL[s.state];
}

// The engine's state and its controls. Starting takes about ten seconds; any Claude local
// terminal starts it too, so the buttons are a shortcut, never a requirement.
export function AiRows({
  ai,
  pending,
  error,
  onAction,
}: {
  ai: Ai;
  pending: boolean;
  error: string | null;
  onAction: (a: AiAction) => void;
}) {
  const s = ai.state;
  const on = s.state === "starting" || s.state === "ready";
  return (
    <>
      <Row label="Motor" value={engineText(s)} />
      {s.state === "failed" && s.detail && <p className="text-[12px] text-bad">{s.detail}</p>}
      <p className="text-[12px] text-ink-2">
        {ai.machine ? `Corre en ${ai.machine}. ` : ""}Se apaga tras {s.idleMinutes} min sin uso.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {on ? (
          <button
            type="button"
            className="btn"
            disabled={pending}
            onClick={() => onAction({ stop: true })}
          >
            Apagar
          </button>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={pending || s.gameMode}
            onClick={() => onAction({ start: true })}
          >
            Encender
          </button>
        )}
        <label className="flex items-center gap-1.5 text-[12px] text-ink">
          <input
            type="checkbox"
            checked={s.gameMode}
            disabled={pending}
            onChange={(e) => onAction({ gameMode: e.currentTarget.checked })}
          />
          Modo juego
        </label>
      </div>
      {error && (
        <p role="alert" className="text-[12px] text-bad">
          {error}
        </p>
      )}
    </>
  );
}

export function AiSection() {
  const ai = useAi();
  if (ai.isPending || ai.data === null) return null;
  return (
    <Section title="IA local">
      {ai.isError && (
        <p className="text-[12px] text-bad">
          {ai.data ? "Sin actualizar: " : "No disponible: "}
          {errorText(ai.error)}
        </p>
      )}
      {ai.data && <AiControls ai={ai.data} />}
    </Section>
  );
}

function AiControls({ ai }: { ai: Ai }) {
  const action = useAiAction(ai.base);
  return (
    <AiRows
      ai={ai}
      pending={action.isPending}
      error={action.isError ? errorText(action.error) : null}
      onAction={(a) => action.mutate(a)}
    />
  );
}
