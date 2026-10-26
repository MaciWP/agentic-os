import { Link } from "@tanstack/react-router";
import type { TerminalKind } from "../../../server/features/terminals/contract.ts";
import { relativeTime } from "../../format.ts";
import { mesaSearch } from "../terminals/mesas.ts";
import { shortPath } from "../terminals/panel.tsx";
import { HARNESS_LABEL, nodeKey, terminalLabel } from "../terminals/queries.ts";
import { statusColor } from "../tickets/icons.tsx";
import type { Source } from "./data.ts";
import type { InboxItem, NeedItem, Urgency } from "./inbox.ts";

// What every direction shows for one item; the directions differ in how they lay it out.
export type Tone = "bad" | "warn" | "accent" | "ok" | "muted";

export type Shown = {
  // Who: a harness (its colour and name), a repo#number or a ticket key.
  harness: TerminalKind | null;
  who: string;
  // What: the ticket summary, the PR title, where an agent runs.
  title: string;
  // The state in the source's own word, and the colour that goes with the word.
  state: string;
  tone: Tone;
  stateColor?: string;
  ticket: string | null;
  when: string | null;
};

const URGENCY_TONE: Record<Urgency, Tone> = {
  failed: "bad",
  asks: "warn",
  review: "accent",
  idle: "muted",
};

export const TONE_TEXT: Record<Tone, string> = {
  bad: "text-bad",
  warn: "text-warn",
  accent: "text-primary",
  ok: "text-ok",
  muted: "text-ink-2",
};

export const TONE_DOT: Record<Tone, string> = {
  bad: "bg-bad",
  warn: "bg-warn",
  accent: "bg-primary",
  ok: "bg-ok",
  muted: "border border-ink-2",
};

export function show(item: InboxItem | NeedItem): Shown {
  const urgency = "urgency" in item ? item.urgency : null;
  switch (item.kind) {
    case "agent": {
      const { t } = item;
      return {
        harness: t.harness,
        who: terminalLabel(t),
        title: shortPath(t.cwd),
        state: item.label,
        tone: urgency ? URGENCY_TONE[urgency] : item.label === "trabajando" ? "ok" : "muted",
        ticket: t.ticket,
        when: t.endedAt ?? t.lastOutputAt ?? t.startedAt,
      };
    }
    case "outside":
      return {
        harness: item.s.harness,
        who: HARNESS_LABEL[item.s.harness],
        title: item.s.name ?? shortPath(item.s.cwd),
        state: item.label,
        tone: urgency ? URGENCY_TONE[urgency] : item.label === "trabajando" ? "ok" : "muted",
        ticket: null,
        when: item.s.updatedAt ?? item.s.startedAt,
      };
    case "pr":
      return {
        harness: null,
        who: `${item.pr.repo.split("/").pop()}#${item.pr.number}`,
        title: item.pr.title,
        state:
          item.pr.kind === "review" ? "te piden revisión" : item.pr.draft ? "borrador" : "tuya",
        tone: urgency ? URGENCY_TONE[urgency] : "muted",
        ticket: null,
        when: item.pr.updatedAt,
      };
    case "ticket":
      return {
        harness: null,
        who: item.ticket.key,
        title: item.ticket.summary,
        // Jira's own status name, unchanged.
        state: item.ticket.status.name,
        tone: "muted",
        stateColor: statusColor(item.ticket.status.name),
        ticket: null,
        when: item.ticket.updated,
      };
  }
}

export const ago = (iso: string | null, now: number) => (iso ? relativeTime(iso, now) : "");

export type ActionProps = { item: InboxItem; className?: string; label?: string };

// The one navigation each item ends in: the Mesa, Agentes, GitHub or the ticket. Never a write.
// The accessible name starts with the visible word, so "Retomar" can be said aloud to press it.
export function ItemAction(props: ActionProps) {
  const { item, className = "btn-ghost", label } = props;
  const s = show(item);
  const text =
    label ??
    (item.kind === "pr" && item.pr.kind === "review"
      ? "Revisar"
      : item.kind === "outside"
        ? "Ver"
        : "Abrir");
  switch (item.kind) {
    case "agent":
      return (
        <Link
          to="/terminales"
          search={mesaSearch({ node: nodeKey(item.t), t: item.t.id })}
          className={className}
          aria-label={`${text} en la Mesa: ${s.who} en ${s.title}`}
        >
          {text}
        </Link>
      );
    case "outside":
      return (
        <Link
          to="/agentes"
          className={className}
          aria-label={`${text} en Agentes: ${s.who} en ${s.title}`}
        >
          {text}
        </Link>
      );
    case "pr":
      return (
        <a
          href={item.pr.url}
          target="_blank"
          rel="noreferrer"
          className={className}
          aria-label={`${text} en GitHub: ${s.who}`}
        >
          {text}
        </a>
      );
    case "ticket":
      return (
        <Link
          to="/tickets/$key"
          params={{ key: item.ticket.key }}
          className={className}
          aria-label={`${text} ${s.who}`}
        >
          {text}
        </Link>
      );
  }
}

// The harness colour beside its name; the name stays text, the colour only helps.
const BARE_NAMES = new Set(Object.values(HARNESS_LABEL));
export function Who({ s }: { s: Shown }) {
  if (s.harness)
    return (
      // A named terminal can carry a sentence: the chip is bounded and yields first when tight.
      // A bare harness name is a word that never gets cut.
      <span
        className={`harness-chip max-w-[22ch] ${BARE_NAMES.has(s.who) ? "shrink-0" : "min-w-0"}`}
        data-harness={s.harness}
        title={s.who}
      >
        <span className="truncate">{s.who}</span>
      </span>
    );
  // repo#number: a long repo name gives way, the number that tells PRs apart never does.
  const hash = s.who.lastIndexOf("#");
  return (
    <span
      className="flex min-w-0 shrink font-mono text-[12px] text-ink-2 tabular-nums"
      title={s.who}
    >
      <span className="truncate">{hash > 0 ? s.who.slice(0, hash) : s.who}</span>
      {hash > 0 && <span className="shrink-0">{s.who.slice(hash)}</span>}
    </span>
  );
}

export const SOURCE_WORD: Record<Source["id"], string> = {
  agents: "los agentes",
  prs: "las PR de GitHub",
  tickets: "los tickets de Jira",
};
