import { Icon } from "../../icons.tsx";
import { cpuText, memText } from "../monitor/queries.ts";
import { HarnessMark } from "../terminals/harness.tsx";
import { AGENTS, peakText, planStale, planText, totals } from "./plan-text.ts";
import type { SystemSnapshot } from "./queries.ts";

// The top bar's line: each harness's initial with its use nearest the limit, and the awake
// mark (the screen one while the screen lock is held off). Below 1440 px only one glyph fits
// beside a page's own bar: that mark, or the gauge. The title spells out every window and what
// everything costs; the panel has the rest.
export function SystemLine({ s, now }: { s: SystemSnapshot; now: number }) {
  const sum = totals(s);
  const title = [
    `${s.terminals.length} term. en marcha`,
    cpuText(sum.cpu),
    memText(sum.rssKb),
    ...AGENTS.map(({ id, name }) => `${name} ${planText(s.plans[id], now)}`),
    ...(s.app.hostStale ? ["PTY host con código antiguo"] : []),
  ].join(" · ");
  return (
    <span title={title} className="flex items-center gap-1.5 whitespace-nowrap tabular-nums">
      {!s.awake.held && !s.awake.screen && (
        <span className="contents min-[1440px]:hidden">
          <Icon name="system" size={14} />
        </span>
      )}
      {AGENTS.map(({ id }) => {
        const plan = s.plans[id];
        const peak = peakText(plan, now);
        // Grok never has a source: its initial alone, dimmed, not a warning that never clears.
        if (peak === null && id === "grok")
          return (
            <span key={id} className="hidden opacity-40 min-[1440px]:inline-flex">
              <HarnessMark kind={id} />
            </span>
          );
        const warn = peak === null || planStale(plan, now);
        return (
          <span key={id} className="hidden items-center gap-0.5 min-[1440px]:inline-flex">
            <HarnessMark kind={id} />
            <span className={warn ? "text-warn" : ""}>{peak ?? "—"}</span>
          </span>
        );
      })}
      {s.awake.screen ? (
        <span className="text-ok" title="La pantalla no se bloquea">
          <Icon name="screen" size={14} />
        </span>
      ) : (
        s.awake.held && (
          <span className="text-ok" title="El Mac se mantiene despierto">
            <Icon name="awake" size={14} />
          </span>
        )
      )}
    </span>
  );
}
