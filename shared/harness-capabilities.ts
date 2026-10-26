import { z } from "zod";
export const HarnessSchema = z.enum(["shell", "claude", "codex", "grok"]);
export type Harness = z.infer<typeof HarnessSchema>;
export const EffortSchema = z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof EffortSchema>;
// Consultations advertise only the restricted adapter's verified capabilities.
// Interactive sessions retain the user's existing bypass policy.
export const HARNESS_CAPABILITIES: Record<
  Exclude<Harness, "shell">,
  { interactive: readonly Effort[]; consultation: readonly Effort[] }
> = {
  claude: {
    interactive: ["low", "medium", "high", "xhigh", "max"],
    consultation: ["low", "medium", "high", "max"],
  },
  codex: {
    interactive: ["minimal", "low", "medium", "high", "xhigh"],
    consultation: ["minimal", "low", "medium", "high", "xhigh"],
  },
  grok: { interactive: ["low", "medium", "high"], consultation: [] },
};

type Agent = Exclude<Harness, "shell">;

// A model id is one argv element: no leading '-', no '=' (Codex reads `-c key=value`).
export const ModelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/);

// The model id that sends a Claude terminal to the local model on the GPU machine instead of
// Anthropic (server/features/ai). The engine serves under this same name.
export const LOCAL_MODEL = "local";

// Claude moves 3 lines per wheel event in xterm.js; this sets 6 (its cap is 20). It goes in
// after cleanEnv, which strips CLAUDE_CODE_* from the login environment.
const AGENT_ENV: Record<Agent, Record<string, string>> = {
  claude: { CLAUDE_CODE_SCROLL_SPEED: "6" },
  codex: {},
  grok: {},
};

// The variables a harness gets on top of the login environment.
export const envFor = (harness: Harness): Record<string, string> =>
  harness === "shell" ? {} : AGENT_ENV[harness];

// What a run may do, by harness and mode: the one place permission flags are decided.
// `bypass`: a terminal the local user opted into the CLI's bypass mode, resumes included
// (native managed restrictions and hooks may still apply; cwd is not a security boundary).
// `plan`: a new Claude session in plan mode, bypass one approval away.
// `consult`: a read-only consultation, no MCP, no user settings, no web. null: not offered.
export type PermissionMode = "bypass" | "plan" | "consult";
export const PERMISSIONS: Record<Agent, Record<PermissionMode, readonly string[] | null>> = {
  claude: {
    bypass: ["--dangerously-skip-permissions"],
    plan: ["--allow-dangerously-skip-permissions", "--permission-mode", "plan"],
    consult: [
      "--restricted",
      "--permission-mode",
      "dontAsk",
      "--tools",
      "Read,Glob,Grep",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--setting-sources",
      "",
      "--disable-slash-commands",
    ],
  },
  codex: {
    bypass: ["--dangerously-bypass-approvals-and-sandbox"],
    plan: null,
    consult: [
      "--sandbox",
      "read-only",
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--skip-git-repo-check",
      "-c",
      "features.multi_agent=false",
      "-c",
      'web_search="disabled"',
    ],
  },
  grok: { bypass: ["--always-approve", "--no-plan"], plan: null, consult: null },
};

// The ticket kickoff's modes: «Empezar» plans first, «Revisar a fondo» works at once.
export const KICKOFF_PERMISSION = { start: "plan", review: "bypass" } as const satisfies Record<
  string,
  PermissionMode
>;
