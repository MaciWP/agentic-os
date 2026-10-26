import { z } from "zod";
import { BRANCH, ENV_ACTIONS, ENV_NAME, ISSUE_KEY } from "./envs.ts";
import { EffortSchema, HarnessSchema, ModelSchema } from "./harness-capabilities.ts";

// The wire between the server and the PTY host: the host file, every body the host checks and
// every reply the server parses. host-contract.test.ts ties PROTOCOL to a hash of these
// shapes, so a change here without a new number fails the check.

// Bumped whenever a host route or frame changes shape, or the host learns a new location
// kind. A server only talks to a host with the same number.
export const PROTOCOL = 10;

export const HostFile = z.object({
  port: z.number().int().positive(),
  token: z.string().min(32),
  pid: z.number().int().positive(),
  protocol: z.number().int(),
  // The fingerprint of the code the host runs (hostBuild), as the server that started it
  // computed it. A file from before builds were recorded has none.
  build: z.string().optional(),
});
export type HostFile = z.infer<typeof HostFile>;

export const Health = z.object({
  protocol: z.number().int(),
  pid: z.number().int().positive(),
  running: z.number().int().nonnegative(),
  build: z.string().optional(),
});
export type Health = z.infer<typeof Health>;

export const MAX_INPUT = 64 * 1024;
// Under the server's idle timeout (120 s): a longer wait is several calls.
export const MAX_WAIT_MS = 100_000;
export const MAX_NAME = 40;

export const TerminalState = z.enum(["running", "exited", "failed", "lost"]);
export type TerminalState = z.infer<typeof TerminalState>;

// A terminal as the host reports it, and as a launch result is stored.
export const TerminalRecord = z.object({
  id: z.string(),
  // "env" is the env provider's own command; the browser can never pick it as a harness.
  harness: z.enum([...HarnessSchema.options, "env"]),
  location: z.string(),
  cwd: z.string(),
  ticket: z.string().nullable(),
  // The user's own name for it (NameBody), kept in the host's memory only: it ends with the
  // terminal or the host. null shows the harness or the env command.
  name: z.string().nullable(),
  // For an "env" terminal: the env it acts on (null for a command on every env), and the
  // command. Kept in memory only, like the rest of a running terminal's state.
  env: z.string().nullable(),
  action: z.enum(["create", "start", "stop", "update", "remove", "logs", "doctor"]).nullable(),
  state: TerminalState,
  exitCode: z.number().nullable(),
  signal: z.string().nullable(),
  error: z.string().nullable(),
  overflowed: z.boolean(),
  attached: z.boolean(),
  // Busy while the program prints more than an idle one does (activity.ts); null when its
  // output cannot tell (a TUI that redraws while it waits). Idle once ended.
  activity: z.enum(["busy", "idle"]).nullable(),
  // The last output counted for the activity, ISO.
  lastOutputAt: z.string().nullable(),
  // The process the app started, while it runs.
  pid: z.number().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
});
export type TerminalRecord = z.infer<typeof TerminalRecord>;

export const LaunchStatus = z.object({
  fingerprint: z.string(),
  // `rejected`: refused before anything started (`error` says why); a new request is safe.
  state: z.enum(["finished", "pending", "rejected", "uncertain"]),
  terminal: TerminalRecord.nullable(),
  error: z.string().nullable(),
});
export type LaunchStatus = z.infer<typeof LaunchStatus>;

// The server already validated the browser's request and built the prompt; the host checks
// it again, because anything holding the token can call it.
export const LaunchSpec = z.object({
  requestId: z.uuid().optional(),
  requestFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  harness: HarnessSchema,
  location: z.string().min(1).max(200),
  ticket: z.string().min(1).max(200).optional(),
  prompt: z
    .string()
    .max(16 * 1024)
    .optional(),
  model: ModelSchema.optional(),
  effort: EffortSchema.optional(),
  // Claude only: plan mode first, bypass after the user approves the plan.
  plan: z.boolean().optional(),
  cols: z.number().int().optional(),
  rows: z.number().int().optional(),
});
export type LaunchSpec = z.infer<typeof LaunchSpec>;

export const Size = z.object({
  cols: z.number().int().optional(),
  rows: z.number().int().optional(),
});

// What a terminal shows now, as text. `seq` counts the output bytes so far, so a later wait
// can ask for output newer than this read.
export const ScreenText = z.object({ text: z.string(), seq: z.number(), state: TerminalState });
export type ScreenText = z.infer<typeof ScreenText>;

// "idle": output newer than `after` came and then stopped for `quietMs`.
export const WaitResult = z.object({
  reason: z.enum(["exit", "idle", "timeout"]),
  seq: z.number(),
  state: TerminalState,
});
export type WaitResult = z.infer<typeof WaitResult>;

// `true` marks the text as a paste when the program asked for that. `"only"` refuses the
// write unless it did: a multi-line text typed bare into a shell runs line by line.
export const PasteMode = z.union([z.boolean(), z.literal("only")]);
export type PasteMode = z.infer<typeof PasteMode>;
// The bodies an agent's read, input and wait carry, checked again by the PTY host.
export const InputBody = z.object({
  data: z.string().min(1).max(MAX_INPUT),
  paste: PasteMode.optional(),
});
export const WaitBody = z.object({
  after: z.number().int().nonnegative().optional(),
  quietMs: z.number().int().min(100).max(60_000).optional(),
  timeoutMs: z.number().int().min(0).max(MAX_WAIT_MS).optional(),
});

// A terminal's name: trimmed, at most MAX_NAME characters, and an empty one clears it. Control
// and format characters are refused: a bidi override could make one name read as another.
export const NameBody = z.object({
  name: z
    .string()
    .trim()
    .max(MAX_NAME)
    .refine((n) => !/[\p{Cc}\p{Cf}]/u.test(n), "no control or format characters")
    .transform((n) => n || null)
    .nullable(),
});

// What an attached window may send once it is authenticated; the server forwards it as is.
export const Message = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string().max(MAX_INPUT) }),
  z.object({ type: z.literal("resize"), cols: z.number().int(), rows: z.number().int() }),
]);

// The host's one frame on the control socket: its terminals changed, read the list again.
export const CHANGED_FRAME = '{"type":"changed"}';

// A consultation start or cancel the host took.
export const Accepted = z.object({ accepted: z.literal(true) });

// Any reply that is not 2xx or 404.
export const ErrorReply = z.object({
  error: z.string().optional(),
  detail: z.unknown().optional(),
  provider: z.string().optional(),
  status: z.number().int().optional(),
});

// The env commands the server asks the host to run in a terminal.
export const RunEnvRequest = z.object({
  action: z.enum(ENV_ACTIONS),
  name: z.string().regex(ENV_NAME).optional(),
  confirm: z.string().max(100).optional(),
});
export type RunEnvRequest = z.infer<typeof RunEnvRequest>;

export const CreateEnvRequest = z.object({
  name: z.string().regex(ENV_NAME),
  repos: z.array(z.string()).min(1).max(10),
  // The ticket key. Without `branches` every repo gets a new `feature/<key>`.
  branch: z.string().regex(ISSUE_KEY),
  // Existing branches per repo (a PR's head, to review it): each repo checks out its own.
  branches: z.record(z.string(), z.string().regex(BRANCH)).optional(),
});
export type CreateEnvRequest = z.infer<typeof CreateEnvRequest>;
