import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Where a service may be built: each process's composition root.
const ROOTS = new Set([
  "server/deps.ts", // the server's: `build` for every service, `serverRoot` for the process's own
  "server/host/main.ts", // the PTY host process
]);
// Parts, not services: each belongs to the one object that builds it, by design.
const PARTS: Record<string, string> = {
  Lifecycle: "a root's own list of start and stop hooks",
  Listeners: "a listener list, a field of whatever it notifies for",
  Screen: "one terminal's screen, built by TerminalManager per terminal",
  Activity: "one terminal's activity, built by TerminalManager per terminal",
  Splitter: "one terminal's output splitter, built by TerminalManager per terminal",
  LaunchRequests: "TerminalManager's launch ledger",
  SpeakerLinker: "one diarization's speaker bookkeeping, built inside the analysis child process",
  CallWatcher: "the call detector Transcripts.watch() builds and ticks",
  PsSession: "the one PowerShell that run.ts's powershell() keeps open between calls",
  TailProcessor: "the span processor startTelemetry() builds into its process's tracer",
};
// A factory that builds a service, allowed where only a root calls it.
const FACTORIES: Record<string, string> = {
  ImageStore: "server/features/images/sources.ts", // imageStore(), called from deps.ts
};

const sources = [...new Bun.Glob("server/**/*.ts").scanSync(".")].filter(
  (f) => !f.endsWith(".test.ts"),
);
const services = sources.flatMap((file) =>
  [...readFileSync(file, "utf8").matchAll(/^export class (\w+)(?: extends (\w+))?/gm)]
    .filter(([, name, base]) => !base?.endsWith("Error") && !(name && name in PARTS))
    .map(([, name]) => name as string),
);

test("services are built only in a composition root", () => {
  expect(services).toContain("WorkspaceStore");
  const outside = sources.flatMap((file) => {
    const text = readFileSync(file, "utf8");
    return services
      .filter((name) => text.includes(`new ${name}(`))
      .filter((name) => !ROOTS.has(file) && FACTORIES[name] !== file)
      .map((name) => `${file}: new ${name}(`);
  });
  expect(outside).toEqual([]);
});

test("every allowed exception still names a class that exists", () => {
  const exported = sources.flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/^export class (\w+)/gm)].map(([, name]) => name),
  );
  expect(Object.keys({ ...PARTS, ...FACTORIES }).filter((n) => !exported.includes(n))).toEqual([]);
});
