import type { ReactNode } from "react";
import { ISSUE_KEY } from "../../../shared/envs.ts";
import { ApiError } from "../../api.ts";
import { relativeTime } from "../../format.ts";
import { Reconnect } from "../../ui.tsx";
import { pct } from "./charts.tsx";
import { Note } from "./kit.tsx";
import type { Ledger } from "./ledger-view.ts";
import {
  type JiraBrief,
  money,
  tokenText,
  tokenTitle,
  totalTokens,
  type UsageReport,
  useJiraBriefs,
} from "./queries.ts";

// Titles and states come from Jira; without it, or while it fails, the ledger shows keys only
// and says why.
export function useBriefs(r: UsageReport) {
  const keys = r.byTicket.map((l) => l.key).filter((k) => ISSUE_KEY.test(k));
  const q = useJiraBriefs(keys);
  const reconnect = q.error instanceof ApiError && q.error.code === "reconnect_required";
  const briefs: Record<string, JiraBrief | null> | null =
    q.data && "briefs" in q.data ? q.data.briefs : null;
  const note: ReactNode = q.isError ? (
    <Note
      tone="bad"
      title={reconnect ? "Jira necesita reconectarse" : "Jira no responde"}
      action={
        <>
          {reconnect && (
            <Reconnect provider="atlassian" className="btn">
              Reconectar Jira
            </Reconnect>
          )}
          <button type="button" className="btn" onClick={() => q.refetch()}>
            Reintentar
          </button>
        </>
      }
    >
      Los tickets salen solo con su clave, sin título ni estado.
    </Note>
  ) : q.data && "disabled" in q.data ? (
    <Note title="Jira no está configurado">Los tickets salen solo con su clave.</Note>
  ) : null;
  return { briefs, note };
}

// One line on what the figures are made of, where the page used to open and close with it.
export function Meta({ r, now }: { r: UsageReport; now: number }) {
  return (
    <p className="max-w-[90ch] text-[12px] text-ink-2 tabular-nums">
      {r.total.cost !== null && <span>{money(r.total.cost)} equivalente API · </span>}
      <span title={tokenTitle(r.total)}>{tokenText(totalTokens(r.total))} tokens</span> ·{" "}
      <span>{r.total.calls.toLocaleString("es-ES")} llamadas</span>
      {r.ingest.lastRunAt &&
        ` · transcripts leídos ${relativeTime(r.ingest.lastRunAt, now)}, ${r.ingest.files.toLocaleString("es-ES")} ficheros de Claude, Codex y Grok`}
    </p>
  );
}

// What the figures mean: tokens with no prices, or a cost that is the API's price, not a bill,
// with the models it leaves out.
export function PriceNote({ L, r }: { L: Ledger; r: UsageReport }) {
  if (L.o.unit === "tokens")
    return (
      <Note title="Sin precios">
        Ningún modelo de este periodo tiene precio en data/config.json, así que las cifras van en
        tokens, y el {pct(L.o.cacheShare)} son lecturas de caché. Con precios, todo pasa a coste.
      </Note>
    );
  return (
    <Note title="Coste equivalente en la API">
      Con los precios de pricing en data/config.json; una suscripción no se cobra por token. Los
      tokens incluyen la caché.
      {r.unpriced.length > 0 && (
        <>
          {" "}
          Sin precio, fuera del coste: <span className="font-mono">{r.unpriced.join(", ")}</span>
          {". Las filas con * llevan parte de sus tokens."}
        </>
      )}
    </Note>
  );
}

export function IngestNote({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null;
  return (
    <Note tone="bad" title={`No se pudieron leer ${errors.length} ficheros`}>
      Lo que contienen falta en las cifras.
      <span className="mt-1 flex flex-col font-mono text-[11px]">
        {errors.slice(0, 5).map((e) => (
          <span key={e} className="truncate" title={e}>
            {e}
          </span>
        ))}
      </span>
    </Note>
  );
}
