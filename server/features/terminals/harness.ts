import { z } from "zod";
import {
  type Effort,
  envFor,
  HARNESS_CAPABILITIES,
  type Harness,
  LOCAL_MODEL,
  ModelSchema,
  PERMISSIONS,
} from "../../../shared/harness-capabilities.ts";
import type { HostConfig } from "../../config-host.ts";
import { LaunchError } from "../../launching.ts";

export {
  type Effort,
  EffortSchema,
  type Harness,
  HarnessSchema,
} from "../../../shared/harness-capabilities.ts";

// Kept here for the callers inside terminals; other features import ../../launching.ts.
export {
  LaunchError,
  type Location,
  listLocations,
  resolveLocation,
} from "../../launching.ts";

export const MAX_PROMPT_BYTES = 16 * 1024;

// The prompt is a single argv element, never shell text. It must not look like an option.
// Server-built prompts always start with a fixed header, so they never match a subcommand.
export function checkPrompt(prompt: string): string {
  if (prompt.startsWith("-")) throw new LaunchError("prompt must not start with '-'");
  if (prompt.includes("\0")) throw new LaunchError("prompt must not contain NUL");
  if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw new LaunchError("prompt too long");
  return prompt;
}

type Agent = Exclude<Harness, "shell">;

// Codex and Grok draw inline, so their output lands in xterm's scrollback: the scrollbar shows
// and the wheel scrolls it. In the alternate screen they ask for no mouse reports, and xterm
// turns the wheel into arrow keys, which they read as prompt history. Claude stays fullscreen:
// it takes the wheel through mouse tracking.
const INLINE: Record<Agent, string[]> = {
  claude: [],
  codex: ["--no-alt-screen"],
  grok: ["--no-alt-screen"],
};

const effortArgs: Record<Agent, (e: Effort) => string[]> = {
  claude: (e) => ["--effort", e],
  codex: (e) => ["-c", `model_reasoning_effort=${e}`],
  grok: (e) => ["--reasoning-effort", e],
};
const modelArgs: Record<Agent, (m: string) => string[]> = {
  claude: (m) => ["--model", m],
  codex: (m) => ["-m", m],
  grok: (m) => ["-m", m],
};

// A harness's session id, as its CLI takes it back: a UUID, so never an option.
export const SessionIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

// `resume` reopens that session; it takes no prompt. `pick` (Codex only) opens Codex's own
// list of this folder's sessions, for a lost terminal whose session id was never found.
// `plan` (Claude only) starts in plan mode with bypass one approval away, instead of in it.
export type LaunchOptions = {
  prompt?: string;
  model?: string;
  effort?: Effort;
  resume?: string;
  pick?: boolean;
  plan?: boolean;
};

// Fixed server map from harness id to argv. Callers only ever pick an id, a model id and an
// effort level; every flag is built here.
export function argvFor(harness: Harness, config: HostConfig, opts: LaunchOptions = {}): string[] {
  const { shell, bins } = config.terminals;
  const { prompt, model, effort, resume, pick, plan } = opts;
  if (harness === "shell") {
    if (
      prompt !== undefined ||
      model !== undefined ||
      effort !== undefined ||
      resume !== undefined ||
      pick ||
      plan
    )
      throw new LaunchError("a shell takes no prompt, model, effort, session or plan mode");
    // pwsh has no login flag; -l is zsh/bash only.
    return process.platform === "win32" ? [shell, "-NoLogo"] : [shell, "-l"];
  }
  if (resume !== undefined) {
    if (!SessionIdSchema.safeParse(resume).success) throw new LaunchError("invalid session id");
    if (prompt !== undefined) throw new LaunchError("a resumed session takes no prompt");
  }
  if (plan && (harness !== "claude" || resume !== undefined))
    throw new LaunchError("only a new Claude session starts in plan mode");
  if (pick) {
    if (harness !== "codex") throw new LaunchError(`${harness} has no session picker here`);
    if (resume !== undefined || prompt !== undefined)
      throw new LaunchError("a session picker takes no session or prompt");
  }
  // Resumes use the same permissions. Codex reopens a session with its own subcommand, and
  // without an id that subcommand lists the folder's sessions.
  const codexResume = harness === "codex" && (resume !== undefined || pick === true);
  const argv = [
    bins[harness],
    ...(codexResume ? ["resume", ...(resume !== undefined ? [resume] : [])] : []),
    ...(PERMISSIONS[harness][plan ? "plan" : "bypass"] ?? []),
    ...INLINE[harness],
  ];
  if (resume !== undefined && harness !== "codex") argv.push("--resume", resume);
  if (model !== undefined) {
    if (!ModelSchema.safeParse(model).success) throw new LaunchError("invalid model id");
    if (model === LOCAL_MODEL && harness !== "claude")
      throw new LaunchError("only Claude runs on the local model");
    if (model === LOCAL_MODEL && effort !== undefined)
      throw new LaunchError("the local model takes no effort level");
    argv.push(...modelArgs[harness](model));
  }
  if (effort !== undefined) {
    if (!HARNESS_CAPABILITIES[harness].interactive.includes(effort))
      throw new LaunchError(
        `${harness} takes effort ${HARNESS_CAPABILITIES[harness].interactive.join(", ")}`,
      );
    argv.push(...effortArgs[harness](effort));
  }
  if (prompt !== undefined) argv.push(checkPrompt(prompt));
  return argv;
}

// The variables a terminal gets on top of the login environment.
export const terminalEnv = (
  harness: Harness,
  config: HostConfig,
  model?: string,
): Record<string, string> => ({
  ...envFor(harness),
  ...(harness === "claude" && model === LOCAL_MODEL ? localModelEnv(config) : {}),
});

// A Claude terminal on the local model: Claude Code runs here, beside the files, and only the
// model runs on the GPU machine, through this server (its own engine, or the hub's relay to the
// worker that has one, server/features/ai). The Origin header passes local-guard the way `aos`
// does. The placeholder token keeps Claude from sending the user's Anthropic login there; a
// token, not ANTHROPIC_API_KEY, which the interactive TUI stops to ask the user to approve.
export function localModelEnv(config: HostConfig): Record<string, string> {
  const own = `http://127.0.0.1:${config.port}`;
  const { engine, machine } = config.ai ?? {};
  const base = engine ? `${own}/api/ai` : machine ? `${own}/api/machines/${machine}/ai` : null;
  if (!base)
    throw new LaunchError("no local model here: config.json needs ai.engine or ai.machine");
  return {
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_AUTH_TOKEN: "local",
    ANTHROPIC_DEFAULT_OPUS_MODEL: LOCAL_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: LOCAL_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: LOCAL_MODEL,
    ANTHROPIC_CUSTOM_HEADERS: `Origin: ${own}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    // A queued request waits for the engine's one slot; the hub's relay waits as long.
    API_TIMEOUT_MS: "600000",
  };
}
