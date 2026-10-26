// Tailscale as this app uses it: the CLI, its status, and the Serve route that lets the other
// devices in. `scripts/remote-setup.ts` sets the route up; the server keeps it (`keepRoute`, once
// a minute) and the hub reads its peers to say why a worker does not answer.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { cached } from "./cache.ts";
import { run } from "./run.ts";

export const Status = z.object({
  BackendState: z.string(),
  Self: z.object({ DNSName: z.string(), UserID: z.number() }),
  User: z.record(z.string(), z.object({ LoginName: z.string() })),
  Peer: z
    .record(
      z.string(),
      z.object({
        DNSName: z.string(),
        Online: z.boolean().optional(),
        LastSeen: z.string().optional(),
      }),
    )
    .optional(),
});
export type Status = z.infer<typeof Status>;

// The CLI on PATH, else where the macOS app and the Windows installer put it.
export function tailscaleBin(): string | null {
  const known = [
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Tailscale", "tailscale.exe"),
  ];
  return Bun.which("tailscale") ?? known.find((p) => existsSync(p)) ?? null;
}

export type Exec = (args: string[], timeoutMs?: number) => Promise<string>;

// One CLI call; a failure throws with Tailscale's own words.
export const tailscaleExec =
  (bin: string): Exec =>
  async (args, timeoutMs = 10_000) => {
    const r = await run([bin, ...args], { timeoutMs });
    if (r.code !== 0)
      throw new Error(
        `Tailscale ${args[0]} failed: ${r.timedOut ? "timed out" : r.stderr.trim() || "check its local app."}`,
      );
    return r.stdout;
  };

// Every loopback port a Serve configuration proxies to, wherever its JSON keeps the target.
export function servedLoopbackPorts(serve: unknown): number[] {
  const ports = new Set<number>();
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      const m = /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost):(\d+)/.exec(v);
      if (m) ports.add(Number(m[1]));
    } else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
  };
  walk(serve);
  return [...ports];
}

// Whether any route, background or foreground, already answers on 443.
function holds443(serve: unknown): boolean {
  if (!serve || typeof serve !== "object") return false;
  const { TCP, Web } = serve as { TCP?: object; Web?: object };
  if ((TCP && "443" in TCP) || Object.keys(Web ?? {}).some((k) => k.endsWith(":443"))) return true;
  return Object.values(serve).some(holds443);
}

export type TunnelStep = { do: "wait" | "up" | "serve" | "ready" } | { do: "stop"; reason: string };
// What ensure does next, from the backend state and the current Serve configuration.
export function tunnelStep(
  backend: string,
  serve: unknown,
  ports: { local: number; remote: number },
): TunnelStep {
  if (backend === "Stopped") return { do: "up" };
  if (backend === "NeedsLogin" || backend === "NeedsMachineAuth")
    return { do: "stop", reason: "Tailscale needs a login: open its app." };
  if (backend !== "Running") return { do: "wait" };
  const served = servedLoopbackPorts(serve);
  if (served.includes(ports.local))
    return {
      do: "stop",
      reason: `Serve proxies to the local port ${ports.local}. Point it at the remote ingress (${ports.remote}) only.`,
    };
  if (served.includes(ports.remote)) return { do: "ready" };
  // Other apps may have their own ports; 443 is this app's, and is never taken from another.
  if (!holds443(serve)) return { do: "serve" };
  return {
    do: "stop",
    reason: "Serve's 443 goes to another app. Review it by hand; ensure never replaces routes.",
  };
}

export const serveArgs = (remotePort: number) => [
  "serve",
  "--bg",
  "--https=443",
  `http://127.0.0.1:${remotePort}`,
];

// One light check of this app's route: a single CLI call while it is there. A missing route is
// put back when Tailscale runs; a stopped or logged-out Tailscale is reported, never started,
// so a disconnect someone chose stays chosen.
export async function keepRoute(
  exec: Exec,
  ports: { local: number; remote: number },
): Promise<TunnelStep | { do: "restored" }> {
  const serve = JSON.parse(await exec(["serve", "status", "--json"]));
  const served = servedLoopbackPorts(serve);
  if (served.includes(ports.remote) && !served.includes(ports.local)) return { do: "ready" };
  const { BackendState } = Status.pick({ BackendState: true }).parse(
    JSON.parse(await exec(["status", "--json"])),
  );
  const step = tunnelStep(BackendState, serve, ports);
  if (step.do !== "serve") return step;
  await exec(serveArgs(ports.remote));
  return { do: "restored" };
}

export type PeerState = { online: boolean; lastSeen: string | null };

// A peer by its Tailscale name (`host.tailnet.ts.net`), or null when this tailnet has none.
export function peerState(status: Status, host: string): PeerState | null {
  const peer = Object.values(status.Peer ?? {}).find((p) => p.DNSName.replace(/\.$/, "") === host);
  if (!peer) return null;
  // An online peer reports the zero time.
  const seen = peer.LastSeen && !peer.LastSeen.startsWith("0001-") ? peer.LastSeen : null;
  return { online: peer.Online ?? false, lastSeen: seen };
}

// How often the server checks its own Serve route: one CLI call, light enough for a gaming PC.
export const ROUTE_CHECK_MS = 60_000;

// Peers by name from one `status --json` shared for 10 s: a list read for several offline
// workers, or every 15 s from several tabs, runs the CLI once.
export function peerReader(exec: Exec): (host: string) => Promise<PeerState | null> {
  const status = cached(async () => Status.parse(JSON.parse(await exec(["status", "--json"]))), {
    ttlMs: 10_000,
  });
  return async (host) => peerState(await status.get(), host);
}
