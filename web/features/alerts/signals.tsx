import { useEffect, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  armChime,
  chime,
  setVolume,
  TUNE_LABEL,
  TUNES,
  type Tune,
  useChimeReady,
  useVolume,
} from "../../chime.ts";
import { Icon, type IconName } from "../../icons.tsx";
import { isNextKey, shortcut } from "../../keys.ts";
import { useRise } from "../../motion.ts";
import { type JobSummary, useEnvJobs } from "../projects/env-jobs.ts";
import { APP_TITLE, isWaiting, seen } from "../terminals/attention.tsx";
import { useOpenTile } from "../terminals/node-link.tsx";
import { type Alert, dismiss, jobAlert, newlyFinished, raise, useAlerts } from "./alerts.ts";
import { askDesktop, type DesktopPermission, desktopPermission, notifyDesktop } from "./desktop.ts";
import { setFavicon } from "./favicon.ts";

// What needs the user, said without covering the page: a chime per kind, the system's
// notification while the app is behind, the count in the tab's title and icon, and in the top
// bar a «Siguiente» button that opens the most pressing one. Where each waits shows in the
// Mesas and tiles themselves (features/terminals). Mounted once, in the Shell.

const VISIBLE = 3;
const DONE_MS = 8000;

// Each alert's tune, which also ranks it: a failure first, then asking, then a finished turn or
// exit, then a finished env command.
export const tuneFor = (a: Alert): Tune =>
  a.kind === "asks" ? "asks" : a.tone === "bad" ? "failed" : a.kind === "job_ok" ? "done" : "turn";

// The loudest of a burst.
export const tuneOf = (alerts: Alert[]): Tune =>
  TUNES.find((t) => alerts.some((a) => tuneFor(a) === t)) ?? "done";

// The order «Siguiente» goes through them: the most pressing kind first, and within a kind the
// one waiting longest (the store keeps the newest first).
export const queueOf = (alerts: readonly Alert[]): Alert[] =>
  [...alerts].reverse().sort((a, b) => TUNES.indexOf(tuneFor(a)) - TUNES.indexOf(tuneFor(b)));

// What waits on the user: every alert but a finished env command, which goes by itself.
export const pending = (alerts: readonly Alert[]) => alerts.filter((a) => a.tone !== "ok").length;

// Watches the env commands: one that finishes raises its alert. The first read is silent.
function useJobAlerts() {
  const jobs = useEnvJobs().data?.jobs;
  const before = useRef<Map<string, JobSummary["state"]> | null>(null);
  useEffect(() => {
    if (!jobs) return;
    const done = newlyFinished(before.current, jobs);
    before.current = new Map(jobs.map((j) => [j.id, j.state]));
    raise(done.map(jobAlert));
  }, [jobs]);
}

function useGo() {
  const openTile = useOpenTile();
  return (a: Alert) => {
    if (a.tile) openTile(a.tile);
    if (a.terminal) seen(a.terminal);
    // A terminal's alert goes with its wait: a question keeps both until it gets its answer.
    if (!a.terminal || !isWaiting(a.terminal)) dismiss(a.key);
  };
}

export function Alerts() {
  const alerts = useAlerts();
  const go = useGo();
  const handled = useRef(new WeakSet<Alert>());
  useJobAlerts();
  useEffect(armChime, []);

  // A new alert, or a newer one with a known key: one chime for the burst, and the system's
  // notification for each while the app is not in front.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `go` only reads the latest router
  useEffect(() => {
    const fresh = alerts.filter((a) => !handled.current.has(a) && !a.quiet);
    for (const a of fresh) handled.current.add(a);
    const count = pending(alerts);
    setFavicon(count);
    document.title = count ? `(${count}) ${APP_TITLE}` : APP_TITLE;
    if (fresh.length === 0) return;
    chime(tuneOf(fresh));
    for (const a of fresh.slice(0, VISIBLE)) notifyDesktop(a, () => go(a));
  }, [alerts]);

  // A finished job goes by itself, timed from when it showed: other alerts coming and going
  // must not restart its clock.
  const timers = useRef(new Map<Alert, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const live = new Set(alerts);
    for (const [a, t] of timers.current) {
      if (!live.has(a)) {
        clearTimeout(t);
        timers.current.delete(a);
      }
    }
    for (const a of alerts) {
      if (a.kind === "job_ok" && !timers.current.has(a)) {
        timers.current.set(
          a,
          setTimeout(() => dismiss(a.key), DONE_MS),
        );
      }
    }
  }, [alerts]);
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending.values()) clearTimeout(t);
    };
  }, []);
  return null;
}

const KIND: Record<Tune, { icon: IconName; text: string }> = {
  asks: { icon: "question", text: "text-warn" },
  failed: { icon: "warning", text: "text-bad" },
  turn: { icon: "done", text: "text-ok" },
  done: { icon: "check", text: "text-ok" },
};

// The top bar's two controls: «Siguiente» while something waits, and the sound.
export function Signals() {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <NextWaiting />
      <SoundMenu />
    </div>
  );
}

export function NextWaiting() {
  const alerts = useAlerts();
  const go = useGo();
  const queue = queueOf(alerts);
  const next = queue[0];
  // The tab's count: a finished env command is reachable from here but waits on nobody.
  const count = pending(alerts);
  // Pulses three times again each time one more waits.
  const rise = useRise(count);
  // The shortcut reads the latest of both, from a listener added once.
  const latest = useRef({ next, go });
  latest.current = { next, go };
  // The shortcut works from anywhere, a terminal included (its key handler lets it through).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isNextKey(e)) return;
      e.preventDefault();
      const { next, go } = latest.current;
      if (next) go(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (!next) return null;
  const kind = KIND[tuneFor(next)];
  const keys = shortcut(".", { shift: true });
  return (
    <button
      type="button"
      className="btn h-8 max-w-64 gap-1.5 px-2"
      onClick={() => go(next)}
      aria-label={`Siguiente: ${next.title}, ${next.detail}. ${count} te esperan`}
      title={`${next.title}: ${next.detail} (${keys})`}
    >
      <span key={rise} className={`grid ${kind.text} motion-safe:animate-attention`}>
        <Icon name={kind.icon} size={14} />
      </span>
      {count > 0 && <span className="font-semibold tabular-nums">{count}</span>}
      <span className="hidden min-w-0 max-w-[190px] truncate text-[12px] text-ink-2 xl:inline 2xl:max-w-none">
        {next.title}
      </span>
    </button>
  );
}

// The sound's state and volume, each tune to try, and the system's notifications. Until the
// first click or key the browser keeps audio off: the icon says so, crossed out.
export function SoundMenu() {
  const ready = useChimeReady();
  const volume = useVolume();
  const [permission, setPermission] = useState<DesktopPermission>("default");
  useEffect(() => setPermission(desktopPermission()), []);
  const off = !ready || volume === 0;
  return (
    <Popover modal={false}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="btn-ghost size-8 justify-center"
          aria-label={ready ? "Sonido de los avisos" : "Sonido bloqueado: haz clic en la app"}
          title={ready ? "Sonido de los avisos" : "Sonido bloqueado: haz clic en la app"}
        >
          <Icon name={off ? "muted" : "sound"} size={16} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label="Sonido de los avisos"
        className="w-72 gap-3 p-3 text-[12px]"
      >
        {!ready && (
          <p role="status" className="text-ink-2">
            El navegador tiene el sonido bloqueado hasta que hagas clic o pulses una tecla en la
            app.
          </p>
        )}
        <label className="flex items-center gap-2">
          <span className="shrink-0 text-ink-2">Volumen</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => setVolume(Number(e.currentTarget.value))}
            className="min-w-0 flex-1 accent-[var(--accent)]"
          />
          <span className="w-8 text-right tabular-nums">{Math.round(volume * 100)}</span>
        </label>
        <fieldset className="flex flex-wrap gap-1">
          <legend className="mb-1 text-ink-2">Probar</legend>
          {TUNES.map((t) => (
            <button key={t} type="button" className="btn gap-1" onClick={() => chime(t, true)}>
              <span className={`grid ${KIND[t].text}`}>
                <Icon name={KIND[t].icon} size={12} />
              </span>
              {TUNE_LABEL[t]}
            </button>
          ))}
        </fieldset>
        {permission === "default" && (
          <button
            type="button"
            className="btn self-start"
            onClick={() => void askDesktop().then(setPermission)}
            title="El navegador te pedirá permiso para mostrar notificaciones de macOS"
          >
            Avisarme también fuera de la app
          </button>
        )}
        {permission === "denied" && (
          <p className="text-ink-2">
            Las notificaciones del sistema están bloqueadas en el navegador para esta web.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
