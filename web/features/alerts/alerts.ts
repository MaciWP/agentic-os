import type { TerminalKind } from "../../../server/features/terminals/contract.ts";
import { createStore, useStore } from "../../store.ts";
import type { JobSummary } from "../projects/env-jobs.ts";
import { jobTile } from "../terminals/grid-state.ts";
import {
  ENV_ACTION_LABEL,
  shortPath,
  type TerminalInfo,
  terminalLabel,
} from "../terminals/queries.ts";

// What needs the user to go on: an agent that asks or finished its turn, a terminal that ended,
// an env command that finished. Each shows as a card, chimes, and reaches the system's
// notifications when the app is not in front. One per terminal or job: a newer one replaces it.

export type AlertKind = "asks" | "turn" | "ended" | "job_ok" | "job_failed";
export type Alert = {
  key: string;
  kind: AlertKind;
  tone: "warn" | "bad" | "ok";
  title: string;
  detail: string;
  // The tile «Ir» opens, or null when there is none to open.
  tile: string | null;
  // The terminal it is about, whose own signals (the blinking ring) go with it.
  terminal: string | null;
  // Whose colour its dot takes.
  harness: TerminalKind;
  // Shown again after the page reloaded: it already chimed and notified once.
  quiet?: true;
};

export function terminalAlert(t: TerminalInfo): Alert {
  const base = {
    key: `terminal:${t.id}`,
    title: `${terminalLabel(t)} · ${shortPath(t.cwd)}`,
    tile: t.id,
    terminal: t.id,
    harness: t.harness,
  };
  if (t.state !== "running") {
    const bad = t.state !== "exited" || (t.exitCode !== null && t.exitCode !== 0);
    const code = t.exitCode !== null && t.exitCode !== 0 ? ` con código ${t.exitCode}` : "";
    return {
      ...base,
      kind: "ended",
      tone: bad ? "bad" : "warn",
      detail:
        t.state === "lost"
          ? "se ha perdido"
          : t.state === "failed"
            ? `ha fallado${t.error ? `: ${t.error}` : ""}`
            : `ha terminado${code}`,
    };
  }
  if (t.agent?.asks === "permission")
    return { ...base, kind: "asks", tone: "warn", detail: "pide permiso para seguir" };
  if (t.agent?.asks) return { ...base, kind: "asks", tone: "warn", detail: "te pregunta algo" };
  return { ...base, kind: "turn", tone: "warn", detail: "ha terminado su turno" };
}

export function jobAlert(j: JobSummary): Alert {
  const what = `${ENV_ACTION_LABEL[j.action]}${j.env ? ` ${j.env}` : ""}`;
  const ok = j.state === "ok";
  return {
    key: `job:${j.id}`,
    kind: ok ? "job_ok" : "job_failed",
    tone: ok ? "ok" : "bad",
    title: what,
    detail: ok ? "listo" : `ha fallado${j.error ? `: ${j.error}` : ""}`,
    tile: j.env ? jobTile(j.env) : null,
    terminal: null,
    harness: "env",
  };
}

// The jobs that just finished. The first read is silent; a job seen for the first time already
// finished started and ended between two reads, so it counts.
export function newlyFinished(
  before: ReadonlyMap<string, JobSummary["state"]> | null,
  now: JobSummary[],
): JobSummary[] {
  if (!before) return [];
  return now.filter((j) => j.state !== "running" && before.get(j.id) !== j.state);
}

// Read and watched directly by the tests; views use `useAlerts`.
export const alerts = createStore<readonly Alert[]>([]);

// Newest first; one replaces an older one with its key.
export function raise(add: Alert[]) {
  if (add.length === 0) return;
  const keys = new Set(add.map((a) => a.key));
  alerts.update((now) => [...add, ...now.filter((a) => !keys.has(a.key))]);
}

export const restore = (add: Alert[]) => raise(add.map((a) => ({ ...a, quiet: true })));

export function dismiss(key: string) {
  alerts.update((now) => (now.some((a) => a.key === key) ? now.filter((a) => a.key !== key) : now));
}

// The terminal's own alert goes once the user looks at it, or it no longer waits.
export function dismissTerminals(keep: (id: string) => boolean) {
  alerts.update((now) => {
    const next = now.filter((a) => a.terminal === null || keep(a.terminal));
    return next.length === now.length ? now : next;
  });
}

export const useAlerts = () => useStore(alerts);
