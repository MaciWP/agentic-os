import { useEffect, useState } from "react";
import type { LaunchStatus } from "../../../server/features/terminals/contract.ts";
import { unwrap } from "../../api.ts";
import { machineUrl } from "../../machine.ts";
import { forgetLaunch, pendingLaunches } from "./queries.ts";

const read = () => pendingLaunches.ids().map((key) => ({ key, id: pendingLaunches.get(key) }));
export function LaunchRecovery() {
  const [items, setItems] = useState(read);
  const [checked, setChecked] = useState<Record<string, LaunchStatus | null>>({});
  const [error, setError] = useState("");
  useEffect(() => {
    const update = () => setItems(read());
    window.addEventListener("aos:launch-pending", update);
    return () => window.removeEventListener("aos:launch-pending", update);
  }, []);
  if (!items.length) return null;
  return (
    <details className="shrink-0 border-b border-line bg-panel px-3 py-2 text-[12px]">
      <summary>Hay lanzamientos pendientes de confirmar ({items.length})</summary>
      <p>
        Comprueba si la terminal existe antes de preparar otro intento. Repetir el botón original
        conserva la misma petición.
      </p>
      {items.map((item) => (
        <div key={item.id} className="flex flex-wrap items-center gap-2 py-1">
          <span className="font-mono">{item.id.slice(0, 8)}</span>
          <button
            className="btn"
            type="button"
            onClick={() => {
              void fetch(machineUrl(`/api/terminals/launches/${encodeURIComponent(item.id)}`))
                .then(unwrap)
                .then((result) =>
                  setChecked((s) => ({ ...s, [item.id]: result as LaunchStatus | null })),
                )
                .catch(() => setError("No se ha podido comprobar el lanzamiento."));
            }}
          >
            Comprobar estado
          </button>
          {item.id in checked && (
            <>
              <span>
                {checked[item.id]?.state === "pending"
                  ? "En curso"
                  : checked[item.id]?.state === "finished"
                    ? "Terminal registrada"
                    : checked[item.id]?.state === "rejected"
                      ? `Rechazado sin iniciar nada: ${checked[item.id]?.error}`
                      : "Sin resultado confirmado: revisa el listado de terminales"}
              </span>
              {checked[item.id]?.terminal && (
                <a
                  href={`/terminales?t=${encodeURIComponent(checked[item.id]?.terminal?.id ?? "")}`}
                  className="text-primary"
                >
                  Abrir terminal
                </a>
              )}
              {checked[item.id]?.state !== "pending" && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    forgetLaunch(item.key);
                    setItems(read());
                  }}
                >
                  Preparar nuevo intento
                </button>
              )}
            </>
          )}
        </div>
      ))}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
