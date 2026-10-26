import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, mutate } from "../../api.ts";
import { errorText, Modal } from "../../ui.tsx";
import { field } from "../coordination/queries.ts";
import { newServerUp, RESTART_WAIT_MS } from "../system/queries.ts";

// «Actualizar»: the hub sends its code to a worker, which restarts on it. A worker never paired
// asks for its token first (`bun scripts/pair.ts` on it), pasted here from any browser.
export function UpdateDialog({
  machine,
  onClose,
}: {
  machine: { id: string; label: string };
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [token, setToken] = useState("");
  const base = `/api/machines/${encodeURIComponent(machine.id)}`;
  const update = useMutation({
    mutationFn: async () => {
      const { pid } = await mutate<{ pid: number }>(`${base}/update`, "POST");
      if (!(await newServerUp(pid, { url: `${base}/health` })))
        throw new Error(
          `${machine.label} no ha vuelto en ${RESTART_WAIT_MS / 1000} s; mira la ventana de su worker`,
        );
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["machines"] });
      onClose();
    },
  });
  const pair = useMutation({
    mutationFn: () => mutate(`${base}/token`, "PUT", { token: token.trim() }),
    onSuccess: () => update.mutate(),
  });
  const unpaired = update.error instanceof ApiError && update.error.code === "unpaired";
  const busy = update.isPending || pair.isPending;
  return (
    <Modal title={`Actualizar ${machine.label}`} onClose={onClose}>
      <div className="space-y-3 px-4 py-3 text-[12px]">
        <p>
          Envía el código de este Mac a {machine.label} y reinicia su servidor. Sus terminales
          siguen en marcha.
        </p>
        {update.isPending && (
          <p className="text-ink-2" role="status">
            Actualizando {machine.label}… espera a que vuelva.
          </p>
        )}
        {unpaired && (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              pair.mutate();
            }}
          >
            <label className="block space-y-1">
              <span>
                Token de {machine.label}: en él, ejecuta <code>bun scripts/pair.ts</code> y pégalo
                aquí.
              </span>
              <input
                className={`${field} font-mono`}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                data-autofocus
              />
            </label>
            <div className="flex justify-end">
              <button type="submit" className="btn" disabled={busy || token.trim() === ""}>
                Emparejar y actualizar
              </button>
            </div>
          </form>
        )}
        {update.error && !unpaired && <p className="text-bad">{errorText(update.error)}</p>}
        {pair.error && <p className="text-bad">{errorText(pair.error)}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cerrar
          </button>
          {!unpaired && (
            <button
              type="button"
              className="btn"
              data-autofocus
              disabled={busy}
              onClick={() => update.mutate()}
            >
              Actualizar
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
