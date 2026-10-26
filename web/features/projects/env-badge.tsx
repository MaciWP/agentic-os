import type { EnvState } from "./queries.ts";

const ENV_STATE: Record<Exclude<EnvState, "unknown">, { label: string; chip: string }> = {
  busy: {
    label: "trabajando…",
    chip: "bg-primary/15 text-primary motion-safe:animate-attention",
  },
  up: { label: "levantado", chip: "bg-ok/15 text-ok" },
  partial: { label: "a medias", chip: "bg-warn/15 text-warn" },
  down: { label: "parado", chip: "bg-ink-2/15 text-ink-2" },
};

// Whether its servers run, as a chip in the state's colour; the provider's own line per repo
// on hover. In a tight row the word wraps out of sight and the dot stays.
export function EnvBadge({ state, detail }: { state: EnvState; detail: string }) {
  if (state === "unknown") return null;
  const s = ENV_STATE[state];
  return (
    <span
      className={`inline-flex h-[18px] min-w-[18px] flex-wrap content-start items-center gap-x-1 overflow-hidden rounded-full px-1.5 font-medium text-[11px] leading-[18px] ${s.chip}`}
      title={detail ? `${s.label}\n${detail}` : s.label}
    >
      <span aria-hidden className="my-1.5 size-1.5 shrink-0 rounded-full bg-current" />
      {s.label}
    </span>
  );
}

// Whether its servers run, as a dot in the state's colour for a tight row: the word and the
// provider's line per repo on hover, the word for screen readers.
export function EnvDot({ state, detail }: { state: EnvState; detail: string }) {
  if (state === "unknown") return null;
  const s = ENV_STATE[state];
  return (
    <span
      className={`grid size-4 shrink-0 place-items-center rounded-full ${s.chip}`}
      title={detail ? `${s.label}\n${detail}` : s.label}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      <span className="sr-only">{s.label}</span>
    </span>
  );
}
