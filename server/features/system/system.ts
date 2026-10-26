import { type ProcRow, psTree, treeUsage, type Usage } from "../monitor/monitor.ts";
import type { Terminals } from "../terminals/contract.ts";
import type { AwakeState, KeepAwake } from "./keep-awake.ts";
import { type PlanUsage, readCodexUsage, readPlanUsage } from "./plan-usage.ts";

// What the app costs right now, for the top bar: the server, the PTY host, each running
// terminal, whether the Mac is kept awake, and each harness's subscription use.

export type Plans = { claude: PlanUsage; codex: PlanUsage; grok: PlanUsage };

// The PTY host while connected: its pid, and whether it runs older code than the server's
// (kept while its terminals run, so new terminals still get the old launch flags).
export type HostInfo = { pid: number; stale: boolean };

// The terminal's own id; the client names it from the terminals list it already has.
export type SystemTerminal = { id: string; cpu: number | null; rssKb: number | null };

export type SystemSnapshot = {
  // The server with its helpers (ps, git, caffeinate). The PTY host alone: its children are
  // the terminals, counted apart. null when the process was not found.
  app: { server: Usage | null; host: Usage | null; hostStale: boolean };
  terminals: SystemTerminal[];
  awake: AwakeState;
  plans: Plans;
};

// ponytail: Grok keeps no plan limits on disk (only each session's context use); ask its API
// if Grok Build ever exposes them.
const GROK: PlanUsage = { error: "no_source" };

const readPlans = async (): Promise<Plans> => {
  const [claude, codex] = await Promise.all([readPlanUsage(), readCodexUsage()]);
  return { claude, codex, grok: GROK };
};

export type SystemDeps = {
  terminals: Terminals;
  // The PTY host while connected (HostClient.hostInfo). It is the server's child when the server
  // started it, so it is passed as a root of its own: the server's cost stops at it.
  hostInfo?: () => Promise<HostInfo | null>;
  keepAwake?: KeepAwake;
  ps?: () => Promise<ProcRow[]>;
  plans?: () => Promise<Plans>;
  serverPid?: number;
};

export async function systemSnapshot(deps: SystemDeps): Promise<SystemSnapshot> {
  const serverPid = deps.serverPid ?? process.pid;
  const [list, rows, host, plans] = await Promise.all([
    deps.terminals.list(),
    (deps.ps ?? psTree)(),
    deps.hostInfo?.() ?? Promise.resolve(null),
    (deps.plans ?? readPlans)(),
  ]);
  const running = list.filter((t) => t.state === "running");
  const pids = running.flatMap((t) => (t.pid === null ? [] : [t.pid]));
  const usage = treeUsage(rows, [serverPid, ...(host ? [host.pid] : []), ...pids]);
  const hostRow = host === null ? undefined : rows.find((r) => r.pid === host.pid);
  return {
    app: {
      server: usage.get(serverPid) ?? null,
      host: hostRow ? { cpu: hostRow.cpu, rssKb: hostRow.rssKb } : null,
      hostStale: host?.stale ?? false,
    },
    terminals: running.map((t) => {
      const u = t.pid === null ? undefined : usage.get(t.pid);
      return { id: t.id, cpu: u?.cpu ?? null, rssKb: u?.rssKb ?? null };
    }),
    awake: deps.keepAwake?.state() ?? { held: false, since: null, screen: null },
    plans,
  };
}
