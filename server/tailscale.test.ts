import { expect, test } from "bun:test";
import {
  type Exec,
  keepRoute,
  peerState,
  Status,
  servedLoopbackPorts,
  tunnelStep,
} from "./tailscale.ts";

const ports = { local: 4317, remote: 4319 };
const route = (port: number, at = "host.ts.net:443") => ({
  TCP: { [at.split(":")[1] as string]: { HTTPS: true } },
  Web: { [at]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } } },
});

test("diagnose finds a Serve route aimed at a loopback port", () => {
  expect(servedLoopbackPorts(route(4317))).toEqual([4317]);
  expect(
    servedLoopbackPorts({ Web: { h: { Handlers: { "/": { Proxy: "localhost:4319" } } } } }),
  ).toEqual([4319]);
  expect(servedLoopbackPorts(null)).toEqual([]);
});

test("ensure connects Tailscale, restores only its own route and refuses the rest", () => {
  expect(tunnelStep("Stopped", null, ports)).toEqual({ do: "up" });
  expect(tunnelStep("Starting", null, ports)).toEqual({ do: "wait" });
  expect(tunnelStep("NeedsLogin", null, ports).do).toBe("stop");
  expect(tunnelStep("Running", {}, ports)).toEqual({ do: "serve" });
  expect(tunnelStep("Running", null, ports)).toEqual({ do: "serve" });
  expect(tunnelStep("Running", route(4319), ports)).toEqual({ do: "ready" });
  expect(tunnelStep("Running", route(4317), ports).do).toBe("stop");
  expect(tunnelStep("Running", route(8080), ports).do).toBe("stop");
});

test("another app on its own port leaves 443 free for this one", () => {
  expect(tunnelStep("Running", route(8000, "host.ts.net:8443"), ports)).toEqual({ do: "serve" });
  // A foreground route on 443 is still someone else's.
  expect(tunnelStep("Running", { Foreground: { s1: route(8080) } }, ports).do).toBe("stop");
});

// A fake CLI: answers by subcommand and records every call.
function cli(answers: Record<string, unknown>) {
  const calls: string[][] = [];
  const exec: Exec = async (args) => {
    calls.push(args);
    const key = args[0] === "serve" && args[1] === "status" ? "serve" : (args[0] as string);
    return JSON.stringify(answers[key] ?? {});
  };
  return { exec, calls };
}

test("keepRoute costs one call while the route is there", async () => {
  const { exec, calls } = cli({ serve: route(4319) });
  expect(await keepRoute(exec, ports)).toEqual({ do: "ready" });
  expect(calls).toEqual([["serve", "status", "--json"]]);
});

test("keepRoute puts a lost route back while Tailscale runs", async () => {
  const { exec, calls } = cli({ serve: {}, status: { BackendState: "Running" } });
  expect(await keepRoute(exec, ports)).toEqual({ do: "restored" });
  expect(calls.at(-1)).toEqual(["serve", "--bg", "--https=443", "http://127.0.0.1:4319"]);
});

test("keepRoute never starts a stopped Tailscale", async () => {
  const { exec, calls } = cli({ serve: {}, status: { BackendState: "Stopped" } });
  expect(await keepRoute(exec, ports)).toEqual({ do: "up" });
  expect(calls.map((c) => c[0])).toEqual(["serve", "status"]);
});

test("peerState finds a worker by its Tailscale name", () => {
  const status = Status.parse({
    BackendState: "Running",
    Self: { DNSName: "mac.t.ts.net.", UserID: 1 },
    User: {},
    Peer: {
      a: { DNSName: "pc.t.ts.net.", Online: false, LastSeen: "2026-10-11T00:31:00Z" },
      b: { DNSName: "phone.t.ts.net.", Online: true, LastSeen: "0001-01-01T00:00:00Z" },
    },
  });
  expect(peerState(status, "pc.t.ts.net")).toEqual({
    online: false,
    lastSeen: "2026-10-11T00:31:00Z",
  });
  expect(peerState(status, "phone.t.ts.net")).toEqual({ online: true, lastSeen: null });
  expect(peerState(status, "other.t.ts.net")).toBeNull();
});
