import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { DATA_DIR } from "../../config-host.ts";
import { run } from "../../run.ts";
import { traced } from "../../telemetry/span.ts";

// The one way the server reaches the Mac's Outlook: AgenticMac.app (scripts/mac/AgenticMac.swift),
// launched through Launch Services so macOS applies the bundle's own Calendars and Mail grants.
// Run directly from this process tree, the binary inherits Terminal's identity and is denied.
// The other helpers built by scripts/mac/build.ts run the same way (AgenticCapture).
export const helperApp = (name: string) => join(DATA_DIR, "bin", `${name}.app`);
const OUT_DIR = join(DATA_DIR, "mac");

// The helper's reasons, plus the two this side adds: the app is missing, or never answered.
const REASONS = [
  "mail_closed",
  "not_granted",
  "denied",
  "no_exchange",
  "no_inbox",
  "not_found",
  "cancelled",
  "bad_input",
  "timeout",
  "script",
  "not_installed",
  // AgenticCapture's: granted, yet screencapture was refused; or it failed on its own.
  "not_inherited",
  "failed",
] as const;
export type MacReason = (typeof REASONS)[number];

const STATUS: Partial<Record<MacReason, 400 | 404 | 409>> = {
  bad_input: 400,
  not_found: 404,
  cancelled: 409,
};

export class MacError extends Error {
  readonly status: 400 | 404 | 409 | 503;
  constructor(
    readonly code: MacReason,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.status = STATUS[code] ?? 503;
  }
}

const Envelope = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), reason: z.string(), detail: z.string().optional() }),
]);

// The helper's JSON line: its data, or a MacError with its reason.
export function parseEnvelope(text: string): unknown {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new MacError("script", "the helper printed no JSON");
  }
  const envelope = Envelope.safeParse(json);
  if (!envelope.success) throw new MacError("script", "the helper's answer changed shape");
  const answer = envelope.data;
  if (answer.ok) return answer.data;
  const reason = REASONS.find((r) => r === answer.reason) ?? "script";
  throw new MacError(reason, answer.detail);
}

// `input`: data the helper reads from a file whose path ends its arguments (a batch to apply).
// That file lives in the user's temp folder: data/ may sit under Desktop or Documents, which
// macOS guards per app, and a read there waits on a consent the user never asked for.
export type MacRunner = (args: string[], timeoutMs: number, input?: unknown) => Promise<unknown>;

// `open --stdout` appends to an existing file, so every call writes a fresh one and drops it.
// Stopping `open` on timeout leaves the helper to its own deadline (15 to 120 s): Launch
// Services starts it, outside `open`'s process group.
export const runHelper =
  (name: string): MacRunner =>
  (args, timeoutMs, input) =>
    // A span per helper call (`mac Calendar events`); the `open` under it is its own span.
    traced(`mac ${name} ${args[0] ?? ""}`.trim(), "mac", {}, () =>
      runOnce(name, args, timeoutMs, input),
    );

async function runOnce(name: string, args: string[], timeoutMs: number, input: unknown) {
  mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
  const out = join(OUT_DIR, `${randomUUID()}.json`);
  const inDir = input === undefined ? null : mkdtempSync(join(tmpdir(), "agentic-mac-"));
  const file = inDir && join(inDir, "batch.json");
  if (file) writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
  const argv = file ? [...args, file] : args;
  try {
    const done = await run(
      ["open", "-n", "-g", "-W", "-a", helperApp(name), "--stdout", out, "--args", ...argv],
      { timeoutMs },
    );
    if (done.timedOut) throw new MacError("timeout");
    if (done.code !== 0)
      throw new MacError("not_installed", `run \`bun run mac:build ${name}\` to build ${name}.app`);
    let text = "";
    try {
      text = readFileSync(out, "utf8");
    } catch {}
    return parseEnvelope(text);
  } finally {
    rmSync(out, { force: true });
    if (inDir) rmSync(inDir, { recursive: true, force: true });
  }
}

export const runMac = runHelper("AgenticMac");
