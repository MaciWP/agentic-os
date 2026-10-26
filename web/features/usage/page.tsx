import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { PageBar } from "../../page-bar.tsx";
import { ErrorState, SkeletonRows, StaleNotice } from "../../ui.tsx";
import { HarnessUse, Hooks } from "./breakdown.tsx";
import { EffortPanel, SpendStats } from "./effort.tsx";
import { Note, Section, TabHead, UsageTabList } from "./kit.tsx";
import { ALL } from "./ledger.ts";
import { ledgerOf } from "./ledger-view.ts";
import { LogPose } from "./logpose.tsx";
import { Models } from "./models.tsx";
import { IngestNote, Meta, PriceNote, useBriefs } from "./notes.tsx";
import { PeriodPanel } from "./period.tsx";
import { HealthStats, healthFaults, SkillReach } from "./poneglyph.tsx";
import {
  type PeriodPick,
  periodOf,
  type UsageReport,
  type UsageSearch,
  type UsageTab,
  useUsage,
  useUsageHistory,
} from "./queries.ts";
import { Router } from "./router.tsx";
import { pickedKey, TicketLedger, ticketParam } from "./ticket-ledger.tsx";

// What the chosen quota week or month cost: the chart on top, always in view, then one tab per
// topic: spend and tickets, models, Log Pose, the skill router, health and the inventory. Read
// from the transcripts every harness keeps (ADR 0008).
export function UsagePage({ search }: { search: UsageSearch }) {
  const navigate = useNavigate();
  const now = new Date();
  const pick = periodOf(search);
  const usage = useUsage(pick);
  const go = (next: UsageSearch) => void navigate({ to: "/consumo", search: next, replace: true });
  const onPick = (p: PeriodPick) =>
    go({
      ...(p.kind !== "week" && { kind: p.kind }),
      ...(p.offset > 0 && { offset: p.offset }),
      ticket: search.ticket,
      tab: search.tab,
    });
  // A ticket picked on the chart opens in the spend tab; the scroll waits for that panel to
  // mount, since the other tabs' panels are not in the page.
  const [reveal, setReveal] = useState(0);
  const onTicket = (key: string) => {
    go({ ...search, ticket: ticketParam(key), tab: undefined });
    setReveal((n) => n + 1);
  };
  useEffect(() => {
    if (reveal === 0) return;
    const id = requestAnimationFrame(() =>
      document.getElementById("usage-tickets")?.scrollIntoView({ behavior: "smooth" }),
    );
    return () => cancelAnimationFrame(id);
  }, [reveal]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageBar>
        <h1 className="font-semibold">Consumo</h1>
      </PageBar>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-12 px-4 pt-6 pb-16 md:px-8 xl:px-10">
          <PeriodPanel pick={pick} onPick={onPick} onTicket={onTicket} />
          {usage.isPending ? (
            <SkeletonRows count={6} />
          ) : usage.isError && !usage.data ? (
            <ErrorState error={usage.error} onRetry={() => usage.refetch()} />
          ) : (
            <>
              {usage.isError && <StaleNotice error={usage.error} onRetry={() => usage.refetch()} />}
              <UsageBody
                r={usage.data}
                now={now.getTime()}
                search={search}
                onTab={(tab) => go({ ...search, tab: tab === "gasto" ? undefined : tab })}
                onTicket={(key) => go({ ...search, ticket: ticketParam(key) })}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// The period below the chart, by topic. Every figure with a target says what decision it
// serves; counts with none go to the inventory. In Gasto the ledger ranks the tickets, and the
// one picked shows its whole life, which does not fit in one week. Only the open tab's panel
// is in the page.
function UsageBody({
  r,
  now,
  search,
  onTab,
  onTicket,
}: {
  r: UsageReport;
  now: number;
  search: UsageSearch;
  onTab: (tab: UsageTab) => void;
  onTicket: (key: string) => void;
}) {
  const { briefs, note } = useBriefs(r);
  const L = ledgerOf(r, briefs, now);
  const picked = pickedKey(search.ticket);
  const one = picked !== ALL && picked !== "";
  const history = useUsageHistory(one);
  const H = one && history.data ? ledgerOf(history.data, briefs, now) : null;
  const story = H?.tickets.find((t) => t.key === picked);
  return (
    <Tabs
      value={search.tab ?? "gasto"}
      onValueChange={(v) => onTab(v as UsageTab)}
      className="gap-6"
    >
      {note}
      <UsageTabList badge={{ salud: healthFaults(r) }} />
      <Panel tab="gasto">
        <SpendStats r={r} L={L} />
        <Section
          id="usage-tickets"
          title="Tickets"
          hint="¿qué ticket se llevó el gasto? Elige uno para ver toda su historia"
          why="si un ticket se dispara, abrir su historia y ver qué lo encareció"
        >
          <TicketLedger
            L={L}
            now={now}
            picked={picked}
            onPick={onTicket}
            story={H && story ? { L: H, t: story } : null}
          />
        </Section>
      </Panel>
      <Panel tab="modelos">
        <Models r={r} L={L}>
          <EffortPanel r={r} L={L} />
        </Models>
      </Panel>
      <Panel tab="logpose">
        <LogPose v={r.logPose} />
      </Panel>
      <Panel tab="router">
        <Router r={r.router} />
        <Section id="usage-skills" title="Skills" hint="¿cubren el trabajo?">
          <SkillReach r={r} />
        </Section>
      </Panel>
      <Panel tab="salud">
        <HealthStats r={r} />
        <Hooks r={r} />
        <Section id="usage-sources" title="De dónde salen estas cifras">
          <Meta r={r} now={now} />
          <PriceNote L={L} r={r} />
          <IngestNote errors={r.ingest.errors} />
          {r.router && r.router.errors.length > 0 && (
            <Note tone="bad" title="No se ha podido leer algún log del router">
              <span className="font-mono">{r.router.errors.join(" · ")}</span>
            </Note>
          )}
        </Section>
      </Panel>
      <Panel tab="inventario">
        <HarnessUse r={r} />
      </Panel>
    </Tabs>
  );
}

function Panel({ tab, children }: { tab: UsageTab; children: ReactNode }) {
  return (
    <TabsContent value={tab} className="flex min-w-0 flex-col gap-6 text-[13px]">
      <TabHead tab={tab} />
      <div className="flex min-w-0 flex-col gap-12">{children}</div>
    </TabsContent>
  );
}
