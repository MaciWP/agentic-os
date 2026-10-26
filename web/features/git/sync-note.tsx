import { plural } from "../../format.ts";
import { Icon } from "../../icons.tsx";
import { InlineError } from "../../ui.tsx";
import { sync } from "./changes.ts";
import {
  type GitStatus,
  gitErrorText,
  type PullResult,
  type PushResult,
  type SyncOp,
  type SyncResult,
  submoduleText,
  type useGitSync,
} from "./queries.ts";

export function Header({ s, write }: { s: GitStatus; write: ReturnType<typeof useGitSync> }) {
  const { text, words } = sync(s.ahead, s.behind);
  const busy = write.isPending;
  const doing = (op: SyncOp, idle: string, active: string) =>
    busy && write.variables === op ? active : idle;
  const canPush = Boolean(s.branch) && (!s.upstream || Boolean(s.ahead));
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-2 text-[12px]">
      <span className="font-mono font-medium">{s.branch ?? "HEAD separado"}</span>
      {s.upstream ? (
        <span className="truncate font-mono text-ink-2">→ {s.upstream}</span>
      ) : (
        s.branch && <span className="text-ink-2">sin upstream</span>
      )}
      {text && (
        <span className="font-mono text-ink-2 tabular-nums" title={words}>
          <span aria-hidden>{text}</span>
          <span className="sr-only">{words}</span>
        </span>
      )}
      <span className="ml-auto flex flex-wrap gap-1">
        {s.upstream && (
          <button
            type="button"
            className="btn-ghost"
            disabled={busy}
            title="git fetch: trae las ramas del remoto sin tocar tus ficheros"
            onClick={() => write.mutate("fetch")}
          >
            {doing("fetch", "Buscar cambios", "Buscando…")}
          </button>
        )}
        {s.branch && s.upstream && Boolean(s.behind) && (
          <button
            type="button"
            className="btn-ghost gap-1"
            disabled={busy}
            title={`Avanza ${s.branch} hasta ${s.upstream}, solo si no hay que mezclar nada`}
            onClick={() => write.mutate("pull")}
          >
            <Icon name="down" size={13} />
            {doing("pull", "Avanzar", "Avanzando…")}
          </button>
        )}
        {canPush && (
          <button
            type="button"
            className="btn-ghost gap-1"
            disabled={busy}
            title={
              s.upstream
                ? `Sube ${plural(s.ahead ?? 0, "commit", "commits")} a ${s.upstream}; nunca a la fuerza`
                : `Publica ${s.branch} en el remoto y la deja siguiéndolo`
            }
            onClick={() => write.mutate("push")}
          >
            <Icon name="up" size={13} />
            {doing("push", s.upstream ? "Subir" : "Publicar rama", "Subiendo…")}
          </button>
        )}
      </span>
    </div>
  );
}

const isPush = (r: SyncResult): r is PushResult => r !== null && "remote" in r;

// What the last fetch, fast-forward or push did; a refusal in the server's words.
export function SyncNote({
  op,
  result,
  error,
}: {
  op: SyncOp | undefined;
  result: SyncResult | undefined;
  error: Error | null;
}) {
  const line = "border-b border-line px-3 py-2 text-[12px]";
  if (error) {
    const what =
      op === "fetch"
        ? "No se han podido buscar cambios"
        : op === "push"
          ? "No se ha subido"
          : "No avanza";
    return (
      <InlineError className={line}>
        {what}: {gitErrorText(error)}
      </InlineError>
    );
  }
  if (result === undefined) return null;
  if (result && isPush(result)) {
    return (
      <p role="status" className={`${line} text-ink-2`}>
        {result.upstreamSet
          ? `${result.branch} publicada en ${result.remote}; ahora la sigue.`
          : `${result.branch} subida a ${result.remote}: ${plural(result.commits, "commit", "commits")}.`}
      </p>
    );
  }
  const pulled = result as PullResult | null;
  return (
    <p role="status" className={`${line} ${pulled?.submodules?.error ? "text-bad" : "text-ink-2"}`}>
      {!pulled
        ? "Remoto consultado: los contadores ya incluyen lo nuevo."
        : [
            pulled.result === "updated"
              ? `${pulled.branch} avanzada ${plural(pulled.commits, "commit", "commits")}: ${pulled.from?.slice(0, 7)} → ${pulled.to?.slice(0, 7)}.`
              : `${pulled.branch} ya estaba al día con su upstream.`,
            submoduleText(pulled.submodules),
          ]
            .filter(Boolean)
            .join(" ")}
    </p>
  );
}
