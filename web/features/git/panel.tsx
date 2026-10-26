import { sync } from "./changes.ts";
import type { GitSummary } from "./queries.ts";

// The tree's glance at a checkout: commits to push or pull, and files changed. Nothing when it
// is clean and in step with its upstream.
export function GitCounts({ s }: { s: GitSummary | undefined }) {
  if (!s) return null;
  const { text, words } = sync(s.ahead, s.behind);
  const n = `${s.changed}${s.truncated ? "+" : ""}`;
  const changed = s.changed ? `${n} ${s.changed === 1 ? "cambio" : "cambios"}` : "";
  if (!text && !changed) return null;
  const files = s.changed
    ? `${n} ${s.changed === 1 ? "fichero cambiado" : "ficheros cambiados"}`
    : "";
  const label = [words, files].filter(Boolean).join(", ");
  return (
    // In a tight row it is cut with "…"; the title keeps it whole.
    <span className="min-w-0 truncate font-mono text-[11px] text-ink-2 tabular-nums" title={label}>
      <span aria-hidden>{[text, changed].filter(Boolean).join(" · ")}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
