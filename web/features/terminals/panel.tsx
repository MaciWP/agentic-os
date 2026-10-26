import { Icon, type IconName } from "../../icons.tsx";
import { spinRef, useRise } from "../../motion.ts";
import { HarnessLogo } from "./logos.tsx";
import { kindLabel, type TerminalInfo } from "./queries.ts";

export const STATE: Record<TerminalInfo["state"], { label: string; dot: string }> = {
  running: { label: "en marcha", dot: "bg-ok" },
  exited: { label: "terminada", dot: "bg-ink-2" },
  failed: { label: "fallida", dot: "bg-bad" },
  lost: { label: "perdida", dot: "bg-warn" },
};

// What a running agent is doing, as its harness records it (ADR 0008).
export const AGENT_STATE: Record<
  NonNullable<TerminalInfo["agent"]>["state"] & string,
  { label: string; dot: string }
> = {
  // The accent and a pulse, like a busy env: apart from a plain running terminal's steady green.
  working: { label: "trabajando", dot: "bg-primary motion-safe:animate-attention" },
  needs_you: { label: "te necesita", dot: "bg-warn" },
};

// What a terminal's colour and icon say, one phase for every surface (tile, header, rail,
// picker): working, asking the user, done with its turn, plainly running, ended, or broken.
// `color` feeds the tile's band and header (`--phase`), `text` the icon.
export type PhaseKey = "working" | "asks" | "turn" | "running" | "exited" | "failed";
export type Phase = {
  key: PhaseKey;
  label: string;
  icon: IconName | null;
  color: string;
  text: string;
};
const PHASE: Record<PhaseKey, Omit<Phase, "key">> = {
  working: { label: "trabajando", icon: "spinner", color: "var(--accent)", text: "text-primary" },
  asks: { label: "te pregunta", icon: "question", color: "var(--warn)", text: "text-warn" },
  turn: { label: "turno terminado", icon: "done", color: "var(--ok)", text: "text-ok" },
  running: { label: "en marcha", icon: null, color: "var(--ink-2)", text: "text-ink-2" },
  exited: { label: "terminada", icon: null, color: "var(--line)", text: "text-ink-2/60" },
  failed: { label: "fallida", icon: "warning", color: "var(--bad)", text: "text-bad" },
};

export function phaseOf(t: TerminalInfo): Phase {
  const at = (key: PhaseKey, label?: string): Phase => ({
    key,
    ...PHASE[key],
    ...(label && { label }),
  });
  if (t.state === "running") {
    if (t.agent?.state === "working") return at("working");
    if (t.agent?.state === "needs_you")
      return t.agent.asks === "permission"
        ? at("asks", "pide permiso")
        : t.agent.asks
          ? at("asks")
          : at("turn");
    return at("running");
  }
  if (t.state === "exited" && !t.exitCode) return at("exited");
  return at(
    "failed",
    t.state === "exited" ? `terminada con código ${t.exitCode}` : STATE[t.state].label,
  );
}

// A Mesa's phase for its card: working first, since what waits already shows as its pill; then
// failed, asks, done with its turn. null for a Mesa without terminals.
const URGENCY: PhaseKey[] = ["working", "failed", "asks", "turn", "running", "exited"];
export function mesaPhase(terminals: TerminalInfo[]): Phase | null {
  const phases = terminals.map(phaseOf);
  for (const key of URGENCY) {
    const p = phases.find((x) => x.key === key);
    if (p) return p;
  }
  return null;
}

// Why a terminal waits for the user, from the most urgent: it broke, it asks, or it is done (its
// turn, or a plain exit). Its icon and colour are its phase's.
export const WAIT_KINDS = ["failed", "asks", "turn"] as const;
export type WaitKind = (typeof WAIT_KINDS)[number];
export function waitKindOf(t: TerminalInfo): WaitKind {
  const key = phaseOf(t).key;
  return key === "asks" || key === "failed" ? key : "turn";
}
export type WaitCount = Record<WaitKind, number>;
export function waitCount(terminals: TerminalInfo[], waiting: ReadonlySet<string>): WaitCount {
  const count: WaitCount = { asks: 0, failed: 0, turn: 0 };
  for (const t of terminals) if (waiting.has(t.id)) count[waitKindOf(t)] += 1;
  return count;
}

// Where a terminal stands, for the rail's groups. It waits on the user: it broke or ended and
// nobody looked, it asks (looked at or not), or its turn is over (`seen` once looked at: it
// still waits for a prompt, quietly). It runs: an agent at work or a plain process. Or it is
// done: ended and looked at.
export type Standing =
  | { group: "waits"; kind: WaitKind; seen: boolean }
  | { group: "runs"; working: boolean }
  | { group: "done" };
export function standingOf(t: TerminalInfo, waiting: ReadonlySet<string>): Standing {
  const key = phaseOf(t).key;
  if (key === "asks") return { group: "waits", kind: "asks", seen: false };
  if (key === "turn") return { group: "waits", kind: "turn", seen: !waiting.has(t.id) };
  if (waiting.has(t.id)) return { group: "waits", kind: waitKindOf(t), seen: false };
  if (t.state === "running") return { group: "runs", working: key === "working" };
  return { group: "done" };
}
// Most pressing first: broke, asks, a turn nobody looked at, a turn looked at, at work, running,
// done.
export function standingRank(s: Standing): number {
  if (s.group === "waits") return s.kind === "failed" ? 0 : s.kind === "asks" ? 1 : s.seen ? 3 : 2;
  return s.group === "runs" ? (s.working ? 4 : 5) : 6;
}

// In a waiting terminal's dark header, why it waits, as a solid chip in its phase's colour; on
// a narrow header the icon alone. Static: the tile's ring already pulses.
const WAIT_PILL: Record<WaitKind, string> = {
  asks: "Te pregunta",
  failed: "Ha fallado",
  turn: "Ha terminado",
};
// `wide`: the words always show (a rail card, which is no container).
export function WaitPill({ kind, wide = false }: { kind: WaitKind; wide?: boolean }) {
  return (
    <span
      data-part="wait"
      data-wait={kind}
      style={{ background: PHASE[kind].color }}
      className="inline-flex h-5 shrink-0 items-center gap-1 rounded px-1.5 font-semibold text-[11px] text-[#16161c]"
    >
      {PHASE[kind].icon && <Icon name={PHASE[kind].icon} size={12} />}
      {wide ? (
        WAIT_PILL[kind]
      ) : (
        <>
          <span className="hidden @[22rem]:inline">{WAIT_PILL[kind]}</span>
          <span className="sr-only @[22rem]:hidden">{WAIT_PILL[kind]}</span>
        </>
      )}
    </span>
  );
}
// A wait's colour, for what a card tints with it.
export const waitColor = (kind: WaitKind) => PHASE[kind].color;

// An icon button in a terminal's dark header: its name goes in aria-label and title.
export const TERM_ICON =
  "inline-flex size-6 shrink-0 items-center justify-center rounded text-white/65 hover:bg-white/10 hover:text-white";

// The last two segments tell worktrees apart: two "backend" dirs differ by their env.
export { shortPath } from "./queries.ts";

// What a row says a terminal is: the user's name for it, else what its agent works on (the
// session title, or the last prompt where its harness keeps no title), else what runs in it.
export const rowText = (t: TerminalInfo) =>
  t.name ?? t.agent?.title ?? t.agent?.prompt ?? kindLabel(t);

// The state in words: how it runs, plus what the dot cannot say alone.
export const terminalState = (t: TerminalInfo, needsYou: boolean) =>
  `${phaseOf(t).label}${needsYou && t.state !== "running" ? " · te necesita" : ""}${t.overflowed ? " · desbordada" : ""}`;

// The hover of a terminal's text: what runs when the text is something else, the state, and
// the last prompt.
export const terminalHover = (t: TerminalInfo, state: string) =>
  [
    rowText(t) !== kindLabel(t) ? kindLabel(t) : null,
    state,
    t.agent?.prompt ? `Último prompt: ${t.agent.prompt}` : null,
  ]
    .filter(Boolean)
    .join("\n");

// A phase as its coloured icon, or a dot when it has none; it pulses a few times while the user
// has not looked, and again when `count` (how many wait) grows or the page is shown again. The
// words live in `title`; callers add them for screen readers.
export function PhaseIcon({
  phase,
  pulse,
  title,
  count = 1,
}: {
  phase: Phase;
  pulse: boolean;
  title: string;
  count?: number;
}) {
  const rise = useRise(pulse ? count : 0);
  return (
    <span
      key={rise}
      aria-hidden
      title={title}
      data-phase={phase.key}
      className={`grid size-3.5 shrink-0 place-items-center ${phase.text} ${
        pulse ? "motion-safe:animate-attention" : ""
      }`}
    >
      {phase.icon ? (
        // Working turns on the shared spinner timer (web/motion.ts), not a CSS loop.
        <span className="grid" {...(phase.key === "working" && { "data-spin": "", ref: spinRef })}>
          <Icon name={phase.icon} size={14} />
        </span>
      ) : (
        <span className="size-2 rounded-full bg-current" />
      )}
    </span>
  );
}

// A terminal's two marks: its phase as a coloured icon (pulsing until the user looks when it
// waits for them) first, then its harness as a logo. The words live in `title`; callers add
// them for screen readers.
export function TerminalMarks({
  t,
  needsYou,
  state,
}: {
  t: TerminalInfo;
  needsYou: boolean;
  state: string;
}) {
  return (
    <>
      <PhaseIcon phase={phaseOf(t)} pulse={needsYou} title={state} />
      <span title={kindLabel(t)} className="grid shrink-0">
        <HarnessLogo kind={t.harness} />
      </span>
    </>
  );
}
