import { cn } from "cn";
import { RefreshCwIcon } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { errorText } from "../../ui.tsx";
import { duration } from "../monitor/queries.ts";
import type { InboxData } from "./data.ts";
import { type InboxItem, interrupts, type NeedItem } from "./inbox.ts";
import { ago, type Shown, SOURCE_WORD, show, TONE_DOT, TONE_TEXT } from "./parts.tsx";

// Inicio's items in one shape, a case: where it stands, how it shows, how long it has waited,
// and the sources that could not be read. Every view of Inicio draws these.

// Where a case stands, from what interrupts most to what has not started.
export type Level = "failed" | "asks" | "review" | "idle" | "running" | "todo";

export type Case = {
  id: string;
  item: InboxItem;
  level: Level;
  s: Shown;
  // How long it has waited in this state, from the time its source keeps fresh.
  waitMs: number | null;
  // The error a failed terminal left, when it left one.
  error: string | null;
};

const caseOf = (item: InboxItem | NeedItem, level: Level, now: number): Case => {
  const s = show(item);
  const at = s.when ? Date.parse(s.when) : Number.NaN;
  return {
    id: `${item.kind}:${item.id}`,
    item,
    level,
    s,
    waitMs: Number.isNaN(at) ? null : Math.max(0, now - at),
    error: item.kind === "agent" ? item.t.error : null,
  };
};

export function casesOf(data: InboxData): Case[] {
  const { needs, running, todo } = data.inbox;
  return [
    ...needs.map((i) => caseOf(i, i.urgency, data.now)),
    ...running.map((i) => caseOf(i, "running", data.now)),
    ...todo.map((i) => caseOf(i, "todo", data.now)),
  ];
}

// The one headline count every direction shows: questions, failures, review requests.
export const interruptCount = (data: InboxData) => data.inbox.needs.filter(interrupts).length;

// "12 min", "2 h 5 min": the wait as a duration, never "hace…", so a column of waits compares.
export const waitText = (c: Case) => (c.waitMs === null ? "—" : duration(c.waitMs));

// The word for what the user does next, by what the case is.
export function verb(c: Case): string {
  if (c.item.kind === "pr") return c.item.pr.kind === "review" ? "Revisar" : "Abrir";
  switch (c.level) {
    case "failed":
      return "Ver error";
    case "asks":
      return "Responder";
    case "idle":
      return "Retomar";
    case "todo":
      return "Empezar";
    default:
      return "Ver";
  }
}

// Every source that did not come back whole, said once above the cases: a failed fetch is an
// error with its retry, never an empty list.
export function SourceProblems({ data, className }: { data: InboxData; className?: string }) {
  const codexBlind = data.coverage.needs.codexBlind;
  const shown = data.sources.filter((s) => s.state !== "ok");
  if (shown.length === 0 && !codexBlind) return null;
  return (
    <div className={className}>
      <div className="flex flex-col gap-2">
        {shown.map((s) =>
          s.state === "error" ? (
            <Alert key={s.id} variant="destructive">
              <AlertTitle>No se han podido leer {SOURCE_WORD[s.id]}</AlertTitle>
              <AlertDescription>{errorText(s.error)}</AlertDescription>
              <AlertAction>
                <Button size="sm" variant="outline" onClick={s.retry}>
                  <RefreshCwIcon data-icon="inline-start" />
                  Reintentar
                </Button>
              </AlertAction>
            </Alert>
          ) : s.state === "partial" ? (
            <Alert key={s.id}>
              <AlertTitle>{s.label} llegó incompleto</AlertTitle>
              <AlertDescription>{s.problems.join(" · ")}</AlertDescription>
            </Alert>
          ) : s.state === "off" ? (
            <Alert key={s.id}>
              <AlertTitle>{s.label} está desactivado en este perfil</AlertTitle>
            </Alert>
          ) : (
            <Alert key={s.id}>
              <AlertTitle>Cargando {SOURCE_WORD[s.id]}…</AlertTitle>
            </Alert>
          ),
        )}
        {codexBlind && (
          <Alert>
            <AlertTitle>Codex no avisa cuando pide permiso</AlertTitle>
            <AlertDescription>
              Si un Codex lleva rato en marcha, míralo en la Mesa.
            </AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  );
}

// The state in its source's own word with the colour that goes with it. A Jira status keeps
// Jira's colour; everything else takes the tone of its level.
export function State({ c, className }: { c: Case; className?: string }) {
  const { s } = c;
  const jira = s.stateColor ? { color: s.stateColor } : undefined;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[12px] font-medium",
        !jira && TONE_TEXT[s.tone],
        className,
      )}
      style={jira}
    >
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", !jira && TONE_DOT[s.tone])}
        style={jira && { background: s.stateColor }}
      />
      {s.state}
    </span>
  );
}

// How long the case has been where it is, in the word that fits it: a wait for what waits on
// the user, a run time for what works, a last change for tickets and PRs.
export function ageText(c: Case, now: number): string {
  const { item } = c;
  if (item.kind === "agent" && c.level === "running")
    return `lleva ${duration(now - Date.parse(item.t.startedAt))}`;
  if (item.kind === "agent" || item.kind === "outside")
    return c.waitMs === null ? "—" : `espera ${waitText(c)}`;
  return ago(c.s.when, now);
}
