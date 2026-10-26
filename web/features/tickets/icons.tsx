import { workflowProgress } from "./groups.ts";

const STATUS_COLOR: Record<string, string> = {
  QUÉ: "var(--ink-2)",
  "En curso": "var(--warn)",
  "In Product Review": "var(--accent)",
  "Release Ready": "var(--ok)",
};

export function statusColor(status: string): string {
  return STATUS_COLOR[status] ?? "var(--ink-2)";
}

// Linear-style progress pie: outline ring, filled wedge by workflow position.
export function StatusIcon({ status, category }: { status: string; category: string }) {
  const p = workflowProgress(status, category);
  const color = statusColor(status);
  const r = 3.5;
  const angle = p * 2 * Math.PI;
  const x = 7 + r * Math.sin(angle);
  const y = 7 - r * Math.cos(angle);
  const wedge =
    p >= 1
      ? null
      : p > 0
        ? `M7 7 L7 ${7 - r} A${r} ${r} 0 ${p > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)} Z`
        : null;
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden className="shrink-0">
      <circle
        cx="7"
        cy="7"
        r="6"
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeDasharray={p === 0 ? "2 2" : undefined}
      />
      {p >= 1 && <circle cx="7" cy="7" r={r} fill={color} />}
      {wedge && <path d={wedge} fill={color} />}
    </svg>
  );
}

// A ticket's status: its pie and Jira's own name. A cut name keeps the full one in its title.
// Size and colour are the caller's.
export function JiraStatus({
  status,
  className = "",
}: {
  status: { name: string; category: string };
  className?: string;
}) {
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1.5 ${className}`.trim()}
      title={status.name}
    >
      <StatusIcon status={status.name} category={status.category} />
      <span className="truncate">{status.name}</span>
    </span>
  );
}

const TYPE: Record<string, { color: string; glyph: string }> = {
  historia: { color: "var(--ok)", glyph: "M4 3h6v8l-3-2-3 2z" },
  story: { color: "var(--ok)", glyph: "M4 3h6v8l-3-2-3 2z" },
  tarea: { color: "var(--accent)", glyph: "M4.5 7.2l1.8 1.8 3.4-3.6" },
  task: { color: "var(--accent)", glyph: "M4.5 7.2l1.8 1.8 3.4-3.6" },
  bug: { color: "var(--bad)", glyph: "M7 4.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5" },
  epic: { color: "oklch(0.6 0.17 300)", glyph: "M7.8 3L4.5 7.5h2.5L6.2 11l3.3-4.5H7z" },
};

export function TypeIcon({ type }: { type: string }) {
  const t = TYPE[type.toLowerCase()] ?? {
    color: "var(--ink-2)",
    glyph: "M5 5h4v4h-4z",
  };
  const stroke = t.glyph.includes("l1.8");
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" role="img" aria-label={type}>
      <title>{type}</title>
      <rect x="0.5" y="0.5" width="13" height="13" rx="3" fill={t.color} opacity="0.16" />
      <path
        d={t.glyph}
        fill={stroke ? "none" : t.color}
        stroke={stroke ? t.color : "none"}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
