import type { TerminalKind } from "../../../server/features/terminals/contract.ts";
import { HarnessLogo } from "./logos.tsx";
import { kindLabel, type TerminalInfo, terminalLabel } from "./queries.ts";

// The harness colour: one hue per kind (tokens --h-*), the same in both schemes.
export const HarnessDot = ({ kind }: { kind: TerminalKind }) => (
  <span aria-hidden className="harness-dot" data-harness={kind} />
);

// An agent harness as its logo in its colour, for the top bar where names do not fit.
export const HarnessMark = ({ kind }: { kind: "claude" | "codex" | "grok" }) => (
  <HarnessLogo kind={kind} size={13} />
);

// A terminal's name with its harness colour: the label stays text, the colour only helps.
// A long name (an env command, the user's own) truncates instead of pushing its row; a named
// terminal still says what runs in it on hover.
export const HarnessChip = ({ t }: { t: TerminalInfo }) => (
  <span
    className="harness-chip"
    data-harness={t.harness}
    title={t.name ? `${t.name} · ${kindLabel(t)}` : kindLabel(t)}
  >
    <span className="truncate">{terminalLabel(t)}</span>
  </span>
);
