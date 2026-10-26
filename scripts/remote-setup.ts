// diagnose and prepare are read-only: they emit reviewable config and Serve instructions.
// ensure (run by start-agentic-os.command) keeps the reviewed setup alive: it connects Tailscale
// and restores this app's own Serve route when it is missing, never touching other routes.
// No LaunchAgent: start-agentic-os.command keeps the server running (see docs/remote-workspace.md).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DATA_DIR, loadConfig } from "../server/config.ts";
import {
  Status,
  serveArgs,
  servedLoopbackPorts,
  tailscaleBin,
  tailscaleExec,
  tunnelStep,
} from "../server/tailscale.ts";
import { RemoteConfig } from "../shared/access.ts";

async function main() {
  const command = process.argv[2] ?? "diagnose";
  if (!["diagnose", "prepare", "ensure"].includes(command))
    throw new Error(
      "Usage: bun scripts/remote-setup.ts [diagnose | ensure | prepare <new-output-dir>]",
    );
  const config = loadConfig();
  const bin = tailscaleBin();
  const exec = (args: string[], timeout?: number) => {
    if (!bin)
      throw new Error(
        "Tailscale is not installed. Install and sign in on the Mac and client devices first.",
      );
    return tailscaleExec(bin)(args, timeout);
  };
  const run = async (args: string[]) => JSON.parse(await exec(args));
  if (command === "ensure") {
    if (!config.remote.enabled) return;
    if (!bin) throw new Error("Tailscale is not installed; remote access is off.");
    // The App Store build connects through its app; start it in the background if it is closed.
    // Windows runs Tailscale as a service, already up.
    if (process.platform === "darwin") Bun.spawnSync(["open", "-g", "-a", "Tailscale"]);
    const ports = { local: config.port, remote: config.remote.port };
    const done = new Set<string>();
    for (const deadline = Date.now() + 60_000; Date.now() < deadline; await Bun.sleep(2000)) {
      const { BackendState } = Status.pick({ BackendState: true }).parse(
        await run(["status", "--json"]),
      );
      const serve = BackendState === "Running" ? await run(["serve", "status", "--json"]) : null;
      const step = tunnelStep(BackendState, serve, ports);
      if (step.do === "stop") throw new Error(step.reason);
      if (step.do === "ready") {
        console.log(`Remote access is up: ${config.remote.origin}`);
        return;
      }
      // Each action once; afterwards only wait for Tailscale to report it.
      if (step.do === "wait" || done.has(step.do)) continue;
      done.add(step.do);
      if (step.do === "up") {
        console.log("Connecting Tailscale...");
        await exec(["up", "--timeout=30s"], 40_000);
      } else {
        console.log(`Restoring the Serve route to 127.0.0.1:${ports.remote}...`);
        await exec(serveArgs(ports.remote));
      }
    }
    throw new Error("Tailscale did not reach a working tunnel in 60 s.");
  }
  console.log(
    JSON.stringify({
      dataDir: DATA_DIR,
      localPort: config.port,
      remoteEnabled: config.remote.enabled,
      tailscaleInstalled: !!bin,
      activated: false,
    }),
  );
  if (!bin) {
    if (command === "prepare")
      throw new Error("Preparation requires the host's real Tailscale identity.");
    return;
  }
  const status = Status.parse(await run(["status", "--json"]));
  if (status.BackendState !== "Running") throw new Error("Tailscale must be connected.");
  const currentServe = await run(["serve", "status", "--json"]);
  if (command === "diagnose") {
    // The local port has no identity check: Serve must only reach the remote ingress.
    const localPortServed = servedLoopbackPorts(currentServe).includes(config.port);
    console.log(
      JSON.stringify({
        connected: true,
        serveConfigured: currentServe !== null && Object.keys(currentServe).length > 0,
        localPortServed,
      }),
    );
    if (localPortServed) {
      console.error(
        `Serve proxies to the local port ${config.port}. Point it at the remote ingress (${config.remote.port}) only.`,
      );
      process.exitCode = 1;
    }
    return;
  }
  if (!process.argv[3]) throw new Error("Supply a NEW output directory for reviewable artifacts.");
  if (currentServe !== null && Object.keys(currentServe).length > 0)
    throw new Error(
      "Serve already has configuration. Review it manually; this tool will not replace existing routes.",
    );
  const login = status.User[String(status.Self.UserID)]?.LoginName;
  const remote = RemoteConfig.parse({
    enabled: true,
    port: 4319,
    origin: `https://${status.Self.DNSName.replace(/\.$/, "")}`,
    login,
  });
  if (remote.port === config.port) throw new Error("Local port collides with remote port.");
  const out = resolve(process.argv[3]);
  mkdirSync(out, { mode: 0o700 });
  const raw = JSON.parse(readFileSync(join(DATA_DIR, "config.json"), "utf8"));
  writeFileSync(join(out, "config.proposed.json"), JSON.stringify({ ...raw, remote }, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  writeFileSync(
    join(out, "activation.txt"),
    `Review config.proposed.json before installing it as ${join(DATA_DIR, "config.json")}.\nThen restart the server (system panel, Reiniciar el servidor): terminals keep running.\nServe command (private, NOT Funnel):\n${JSON.stringify(bin)} serve --bg --https=443 http://127.0.0.1:${remote.port}\nURL: ${remote.origin}\nVerify with docs/remote-workspace.md before using it unattended.\n`,
    { flag: "wx", mode: 0o600 },
  );
  console.log(`Prepared ${out}. Nothing was activated.`);
}
if (import.meta.main)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
