import type { ReactNode } from "react";
import { clockTime, plural, relativeTime } from "../../format.ts";
import { Icon } from "../../icons.tsx";
import type { DesktopPermission } from "../alerts/desktop.ts";
import { usageText } from "../monitor/parts.tsx";
import { type RendererChoice, type RendererState, softwareGl } from "../terminals/renderer.ts";
import {
  type Agent,
  dayTime,
  pct,
  planStale,
  renewed,
  resetAt,
  type Usage,
  windowName,
} from "./plan-text.ts";
import type { LimitWindow, PlanUsage, ScreenChoice, SystemSnapshot } from "./queries.ts";

export function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-[11px] font-medium tracking-wide text-ink-2 uppercase">{title}</h3>
      {children}
    </section>
  );
}

export function Row({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[12px]">
      <span className="min-w-0 truncate text-ink">{label}</span>
      <span className="shrink-0 text-ink-2 tabular-nums">{value}</span>
    </div>
  );
}

export const usageOr = (u: Usage | null | { cpu: number | null; rssKb: number | null }) =>
  (u && usageText(u.cpu, u.rssKb)) ?? "no encontrado";

const NO_SOURCE: Record<Agent, string> = {
  claude: "Sin dato: abre una sesión de Claude",
  codex: "Sin dato: abre una sesión de Codex",
  grok: "Sin dato: Grok no guarda sus límites en local",
};
const BAD_DATA: Record<Agent, string> = {
  claude: "Sin dato: no se puede leer el uso guardado de Claude",
  codex: "Sin dato: Codex guarda sus límites en otro formato",
  grok: "Sin dato: Grok no guarda sus límites en local",
};

export function PlanRows({ agent, plan, now }: { agent: Agent; plan: PlanUsage; now: number }) {
  if ("error" in plan)
    return (
      <p className={`text-[12px] ${agent === "grok" ? "text-ink-2" : "text-warn"}`}>
        {(plan.error === "no_source" ? NO_SOURCE : BAD_DATA)[agent]}
      </p>
    );
  const row = (w: LimitWindow) => {
    if (renewed(w.resetAt, now)) return "renovada · aún sin dato nuevo";
    const at = resetAt(
      w.resetAt,
      w.minutes <= 1440 ? clockTime : (iso) => dayTime.format(new Date(iso)),
    );
    const when = at && (w.minutes <= 1440 ? `a las ${at}` : `el ${at}`);
    return `${pct(w.percent)}${when ? ` · se renueva ${when}` : ""}`;
  };
  return (
    <>
      {plan.windows.map((w) => (
        <Row key={w.minutes} label={windowName(w.minutes)} value={row(w)} />
      ))}
      <p className={`text-[11px] ${planStale(plan, now) ? "text-warn" : "text-ink-2"}`}>
        Actualizado {relativeTime(plan.updatedAt, now)}
      </p>
    </>
  );
}

// What the line opens: the app, each running terminal, the subscription and the sleep guard.
const SCREEN_CHOICES: { choice: ScreenChoice; label: string }[] = [
  { choice: 60, label: "1 h" },
  { choice: 120, label: "2 h" },
  { choice: 240, label: "4 h" },
  { choice: null, label: "Sin límite" },
];

// The screen lock a managed Mac puts after some idle minutes: held off for a time, or while
// agents work when the config says so.
export function ScreenRow({
  screen,
  pending,
  error,
  onScreen,
}: {
  screen: SystemSnapshot["awake"]["screen"];
  pending: boolean;
  error: string | null;
  onScreen: (choice: ScreenChoice) => void;
}) {
  const state = !screen
    ? "La pantalla se bloquea sola tras unos minutos sin usar el Mac."
    : screen.auto
      ? "Activo mientras trabaja algún agente."
      : screen.until
        ? `Activo hasta las ${clockTime(screen.until)}.`
        : "Activo hasta que lo quites.";
  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex items-center gap-1.5 font-medium text-[12px] text-ink">
        <Icon name="screen" size={14} />
        No bloquear la pantalla
      </p>
      <p className={`text-[12px] ${screen ? "text-ok" : "text-ink-2"}`}>{state}</p>
      <div className="flex flex-wrap gap-1.5">
        {SCREEN_CHOICES.map(({ choice, label }) => (
          <button
            key={label}
            type="button"
            className="btn"
            disabled={pending}
            onClick={() => onScreen(choice)}
          >
            {label}
          </button>
        ))}
        {screen && !screen.auto && (
          <button type="button" className="btn" disabled={pending} onClick={() => onScreen(false)}>
            Quitar
          </button>
        )}
      </div>
      {error && <p className="text-[12px] text-bad">No se ha cambiado: {error}.</p>}
      <p className="text-[11px] text-ink-2">
        Deja la pantalla encendida. Bloquéala a mano con ⌃⌘Q cuando te vayas.
      </p>
    </div>
  );
}

const RENDERER_CHOICES: { choice: RendererChoice; label: string }[] = [
  { choice: "auto", label: "Automático" },
  { choice: "gpu", label: "GPU forzada" },
  { choice: "dom", label: "CPU" },
];

// Who draws this page's terminals, switched live to compare what each costs.
export function RendererRow({
  state,
  onChoose,
}: {
  state: RendererState;
  onChoose: (choice: RendererChoice) => void;
}) {
  const { choice, gpuName, onGpu, total } = state;
  const emulated = gpuName !== null && softwareGl(gpuName);
  const now =
    total === 0
      ? "Ningún terminal abierto en esta pestaña."
      : onGpu === 0
        ? `Ahora: CPU en ${plural(total, "terminal", "terminales")}.`
        : `Ahora: GPU en ${onGpu} de ${plural(total, "terminal", "terminales")}.`;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        {RENDERER_CHOICES.map((c) => (
          <button
            key={c.choice}
            type="button"
            aria-pressed={choice === c.choice}
            className={`btn ${choice === c.choice ? "bg-[var(--selected)] text-ink" : ""}`}
            onClick={() => onChoose(c.choice)}
          >
            {c.label}
          </button>
        ))}
      </div>
      <p className="text-[12px] text-ink">{now}</p>
      <p className="truncate text-[11px] text-ink-2" title={gpuName ?? undefined}>
        {gpuName === null
          ? "Este navegador no tiene WebGL2: dibuja siempre la CPU."
          : `GPU: ${gpuName}`}
      </p>
      {emulated && choice === "auto" && (
        <p className="text-[12px] text-ink-2">
          La GPU de este navegador la emula la CPU: Automático dibuja con la CPU.
        </p>
      )}
      {emulated && choice === "gpu" && (
        <p className="text-[12px] text-warn">
          Con la GPU emulada, «GPU forzada» puede gastar varios núcleos.
        </p>
      )}
      <p className="text-[11px] text-ink-2">
        Se guarda en este navegador. Para comparar, mira la CPU de la pestaña en el administrador de
        tareas del navegador (⇧Esc).
      </p>
    </div>
  );
}

const DESKTOP_STATE: Record<Exclude<DesktopPermission, "default">, string> = {
  granted: "Activos: macOS te avisa cuando la app no está delante.",
  denied:
    "Chrome los tiene bloqueados. Actívalos en el icono a la izquierda de la dirección (Notificaciones) y en Ajustes del Sistema → Notificaciones → Google Chrome.",
  unsupported: "Este navegador no permite avisos del sistema.",
};

export function DesktopRow({
  permission,
  onAsk,
}: {
  permission: DesktopPermission;
  onAsk: () => void;
}) {
  return permission === "default" ? (
    <div className="flex flex-col items-start gap-1.5">
      <p className="text-[12px] text-ink-2">
        Para enterarte con otra app delante: macOS avisa cuando un agente te necesita o algo
        termina.
      </p>
      <button type="button" className="btn" onClick={onAsk}>
        Activar avisos del sistema
      </button>
    </div>
  ) : (
    <p className={`text-[12px] ${permission === "granted" ? "text-ok" : "text-ink-2"}`}>
      {DESKTOP_STATE[permission]}
    </p>
  );
}
