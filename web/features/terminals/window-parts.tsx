import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import { ApiError } from "../../api.ts";
import { errorText } from "../../ui.tsx";
import { TERM_ICON } from "./panel.tsx";
import {
  createTerminal,
  HARNESS_LABEL,
  HARNESSES,
  type Harness,
  type TerminalInfo,
} from "./queries.ts";
import type { Exit, Status } from "./terminal-socket.ts";

// The small parts of a terminal's view: the name field, the next step after an env create, the
// exit's words and the phone's «⋯» menu.

const FOLDER_ERROR: Record<string, string> = {
  editor_not_configured: "No hay editor: añade terminals.editor en config.json.",
  folder_gone: "La carpeta de esta terminal ya no existe.",
};

// Why a rename or "Abrir carpeta" failed, in words.
export const actionError = (err: unknown): string =>
  (err instanceof ApiError && FOLDER_ERROR[err.code]) || errorText(err);

// The name being edited in the header: Enter or leaving the field saves, Esc cancels. Keys stay
// here, so neither the palette nor the Mesa sees them.
export function NameField({
  initial,
  onDone,
}: {
  initial: string;
  onDone: (name?: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (name?: string) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    e.stopPropagation();
    if (e.key === "Enter") finish(value);
    else if (e.key === "Escape") finish();
  }
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: opened by the Renombrar button, which it replaces.
      autoFocus
      aria-label="Nombre de la terminal"
      className="h-6 w-40 min-w-0 shrink rounded border border-white/25 bg-term-bg px-1.5 text-[12px] text-white"
      maxLength={40}
      placeholder="Sin nombre"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(value)}
    />
  );
}

// What the view says above the screen when it does not show the terminal live, and the button
// that fixes it. `quiet` drops "open elsewhere" where nothing needs the terminal here.
export function bannerFor(status: Status, quiet: boolean) {
  if (status.kind === "elsewhere")
    return quiet ? null : { text: "Abierta en otra ventana.", action: "Traer aquí", take: true };
  if (status.kind === "closed") return { text: status.reason, action: "Reconectar", take: false };
  if (status.kind === "missing")
    return { text: "Esta terminal ya no existe.", action: null, take: false };
  if (status.kind === "lost")
    return { text: "Se perdió al reiniciar el servidor.", action: "Reanudar", take: false };
  return null;
}

export function exitText(exit: Exit): string {
  if (exit.state === "failed") return `No ha arrancado: ${exit.error ?? "error desconocido"}`;
  if (exit.state === "lost") return "Se perdió al reiniciar el servidor.";
  if (exit.signal) return `Terminada por ${exit.signal}.`;
  return `Terminada con código ${exit.code ?? "?"}.`;
}

// After the env provider's create: the next step is launching in the new env. The server
// checks the env against the provider's list on that launch, so a bad create cannot pass.
export function EnvNext({
  info,
  exit,
  onOpen,
}: {
  info: TerminalInfo;
  exit: Exit | null;
  onOpen: (terminal: TerminalInfo) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const env = info.env ?? "";
  const ok =
    (exit ?? info).state === "exited" &&
    (exit ?? info).signal === null &&
    (exit ? exit.code : info.exitCode) === 0;
  async function launch(harness: Harness) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const { terminal } = await createTerminal(harness, `env:${env}`, {
        ticket: info.ticket ?? undefined,
      });
      onOpen(terminal);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  }
  if (info.state === "running" && !exit) {
    return (
      <p className="bg-term-bar px-3 py-2 text-[12px] text-white/70">
        Creando el entorno {env}. Si lo paras a medias puede quedar a medio crear; no se borra solo.
      </p>
    );
  }
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 bg-term-bar px-3 py-2 text-[12px]"
    >
      {ok ? (
        <>
          <span>Creación terminada. Lanzar en {env}:</span>
          {HARNESSES.map((h) => (
            <button
              key={h}
              type="button"
              className="rounded bg-term-accent px-2 py-0.5 font-medium text-white disabled:opacity-50"
              disabled={pending}
              onClick={() => launch(h)}
            >
              {HARNESS_LABEL[h]}
            </button>
          ))}
        </>
      ) : (
        <span>
          La creación no ha terminado bien; revisa la salida. El entorno {env} no se borra solo.
        </span>
      )}
      {error && <span className="basis-full text-bad">{error}</span>}
    </div>
  );
}

export function MoreMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        className={`${TERM_ICON} pointer-coarse:size-10`}
        aria-label="Más acciones"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        ⋯
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label="Cerrar el menú"
            className="fixed inset-0 z-30 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute top-full right-0 z-40 mt-1 flex gap-1 rounded-lg border border-white/15 bg-term-bar p-1 shadow-lg *:size-11">
            {children}
          </div>
        </>
      )}
    </div>
  );
}
