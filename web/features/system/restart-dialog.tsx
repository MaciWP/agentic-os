import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "../../api.ts";
import { plural } from "../../format.ts";
import { currentMachine } from "../../machine.ts";
import { errorText, Modal } from "../../ui.tsx";
import type { TerminalInfo } from "../terminals/queries.ts";
import { askRestart, newServerUp, RESTART_WAIT_MS, type RestartScope } from "./queries.ts";

// What a full restart does to the running terminals: on its stop the host marks them lost,
// and the next one resumes every agent (ADR 0008); a shell or an env command has nothing to
// resume.
export function restartLosses(list: TerminalInfo[]) {
  const running = list.filter((t) => t.state === "running");
  const closed = running.filter((t) => t.harness === "shell" || t.harness === "env").length;
  return { closed, resumed: running.length - closed };
}

type RestartPhase = { kind: "idle" } | { kind: "waiting"; scope: RestartScope };

export function RestartDialog({
  list,
  listError,
  hostStale,
  onClose,
  restart = askRestart,
  waitFor = newServerUp,
  reload = () => window.location.reload(),
}: {
  // Undefined until the terminals are read: unread is never "no terminals".
  list: TerminalInfo[] | undefined;
  listError?: string;
  hostStale: boolean;
  onClose: () => void;
  restart?: typeof askRestart;
  waitFor?: (pid: number) => Promise<boolean>;
  reload?: () => void;
}) {
  const [phase, setPhase] = useState<RestartPhase>({ kind: "idle" });
  const run = useMutation({
    mutationFn: async (scope: RestartScope) => {
      const { pid } = await restart(scope);
      setPhase({ kind: "waiting", scope });
      if (!(await waitFor(pid)))
        throw new Error(
          `el servidor no ha vuelto en ${RESTART_WAIT_MS / 1000} s; ${currentMachine ? "mira la ventana de pwsh del worker" : "mira data/server.log en el Mac"}`,
        );
    },
    onSuccess: reload,
    onError: () => setPhase({ kind: "idle" }),
  });
  const losses = list ? restartLosses(list) : null;
  const busy = run.isPending;
  const refusal =
    run.error instanceof ApiError && run.error.code === "restart_refused"
      ? `No se reinicia: ${run.error.detail}`
      : run.error
        ? errorText(run.error)
        : null;
  return (
    <Modal title="Reiniciar Agentic OS" onClose={onClose}>
      <div className="space-y-3 px-4 py-3 text-[12px]">
        <p>
          <strong>Reiniciar el servidor</strong> carga su código nuevo. Los terminales siguen en
          marcha; la página se recarga sola.
        </p>
        <p>
          <strong>Reiniciar todo</strong> reconstruye también la web y reinicia el PTY host, que
          lanza los terminales.
          {!losses
            ? listError
              ? ` No se pudo leer qué terminales hay en marcha: ${listError}.`
              : " Leyendo qué terminales hay en marcha…"
            : losses.closed + losses.resumed === 0
              ? " No hay terminales en marcha."
              : ` ${losses.closed > 0 ? `Se cierran ${plural(losses.closed, "shell o comando de entorno", "shells o comandos de entorno")}. ` : ""}${losses.resumed > 0 ? `${plural(losses.resumed, "agente se reanuda", "agentes se reanudan")} con su sesión (Claude, Codex, Grok).` : ""}`}
        </p>
        {hostStale && (
          <p className="text-warn">
            El PTY host ejecuta código antiguo: solo «Reiniciar todo» lo actualiza.
          </p>
        )}
        {phase.kind === "waiting" && (
          <p className="text-ink-2" role="status">
            {phase.scope === "all" ? "Reiniciando todo" : "Reiniciando el servidor"}… espera a que
            vuelva.
          </p>
        )}
        {refusal && <p className="text-bad">{refusal}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button
            type="button"
            className="btn"
            data-autofocus
            disabled={busy}
            onClick={() => run.mutate("server")}
          >
            Reiniciar el servidor
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
            onClick={() => run.mutate("all")}
          >
            Reiniciar todo
          </button>
        </div>
      </div>
    </Modal>
  );
}
