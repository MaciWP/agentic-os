import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, resolve } from "node:path";
import { z } from "zod";
import { DEV_API_PORT, LOCAL_PORT } from "../shared/runtime.ts";

// The part of config.json the PTY host reads: where terminals start and what they run. It is
// all the host imports of the config, so a field added for a page never stales a running host.
// config.ts extends these sections into the server's full schema.

export const DATA_DIR = resolve(
  process.env.AGENTIC_OS_DATA ??
    join(import.meta.dir, "..", "data", ...(process.env.NODE_ENV === "development" ? ["dev"] : [])),
);
export const APP_ROOT = resolve(import.meta.dir, "..");

// Not "." or "..": those would rewrite the API path the token is sent to.
const GITHUB_NAME = /^(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;

// The sections depend on the platform: what an absolute path looks like, and which
// binaries have a known default. Only macOS has defaults; elsewhere the profile sets them.
export function hostSections(platform: NodeJS.Platform = process.platform) {
  // Windows: a drive letter is required. `\bin\x` hangs off whatever drive the cwd is on,
  // and a `\\host\share` path would run a binary from the network.
  const isAbsolute =
    platform === "win32" ? (p: string) => /^[A-Za-z]:[\\/]/.test(p) : posix.isAbsolute;
  const absolute = z.string().refine(isAbsolute, "must be an absolute path");
  const mac = platform === "darwin";
  // Typed as defaulted on every platform so `prefault({})` type-checks; off macOS a
  // missing value still fails the parse, because the schema there has no default.
  const bin = (macDefault: string) =>
    (mac ? absolute.default(macDefault) : absolute) as ReturnType<typeof absolute.default>;
  const localBin = (name: string) => bin(join(homedir(), ".local/bin", name));

  const RepoSchema = z
    .object({
      id: z.string().min(1),
      // github.com only: the host builds the PR links shown in the browser.
      host: z.literal("github.com").default("github.com"),
      // All three or none: a repo without them is local-only and stays out of the PR inbox.
      owner: z.string().regex(GITHUB_NAME).optional(),
      name: z.string().regex(GITHUB_NAME).optional(),
      login: z.string().min(1).optional(),
      localPath: z.string().min(1),
      // The section of the tree it shows in; without one, "Otros proyectos".
      group: z.string().trim().min(1).max(40).optional(),
    })
    .refine((r) => [r.owner, r.name, r.login].filter(Boolean).length % 3 === 0, {
      message: "owner, name and login go together, or none of them for a local-only repo",
    });

  return {
    absolute,
    mac,
    sections: {
      port: z.number().int().default(LOCAL_PORT),
      repos: z.array(RepoSchema).default([]),
      // A CLI that lists and creates worktree environments (see server/features/envs).
      envs: z
        .object({
          bin: absolute,
          // Where the CLI keeps each environment: <root>/<env>/<repo dir>.
          root: absolute,
          // The repos a new environment may include, as the CLI names them.
          repos: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/)).min(1),
          // The web each checkout of an env serves: the proxy host whose first label is
          // `<prefix><env>`, shown on the checkout of that repo. Hosts no rule names stay out.
          links: z
            .array(
              z.object({
                repo: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/),
                prefix: z.string().regex(/^[a-z0-9-]{0,40}$/),
              }),
            )
            .optional(),
        })
        .optional(),
      // Where the app adds native worktrees: <root>/<repo>/<branch slug>. It must exist and
      // stay outside every checkout and the envs root, or the tree would not list them.
      worktrees: z.object({ root: absolute }).optional(),
      // Reads each repo's worktrees for the projects tree.
      git: z.object({ bin: mac ? absolute.default("/usr/bin/git") : absolute.optional() }),
      terminals: z
        .object({
          shell: bin("/bin/zsh"),
          // "Abrir carpeta" runs `[editor, cwd]`. No default: without it the action says so.
          editor: absolute.optional(),
          // "Carpeta libre": where a terminal starts when it is not about any project. Created
          // on the first launch there.
          scratch: absolute.default(join(homedir(), "agentic-os-scratch")),
          // Absolute paths only: the server's PATH is never used to find what runs in a PTY.
          bins: z
            .object({
              claude: localBin("claude"),
              codex: localBin("codex"),
              grok: localBin("grok"),
            })
            .prefault({}),
        })
        .prefault({}),
      // Claude terminals with model `local` talk to a model on a GPU machine. `engine`: this
      // machine runs it (llama-server on loopback); `machine`: the hub reaches the worker's.
      ai: z
        .object({
          machine: z
            .string()
            .regex(/^[a-z0-9-]{1,32}$/)
            .optional(),
          engine: z
            .object({
              bin: absolute,
              model: absolute,
              // The MTP drafter: faster answers, one request at a time.
              draft: absolute.optional(),
              // A chat template that accepts Claude Code's mid-conversation system notes.
              template: absolute.optional(),
              port: z.number().int().min(1024).max(65535).default(8090),
              contextTokens: z.number().int().min(8192).max(262144).default(131072),
              // Thinking tokens per answer: -1 unlimited, 0 none. Claude Code's effort and
              // thinking settings never reach this model; most of a task's time is thinking.
              reasoningBudget: z.number().int().min(-1).max(65536).default(-1),
              // The model leaves the GPU after this long without a request.
              idleMinutes: z.number().int().min(1).max(240).default(15),
            })
            .optional(),
        })
        .optional(),
    },
  };
}

export function hostConfigSchema(platform: NodeJS.Platform = process.platform) {
  const { sections } = hostSections(platform);
  return z.object({ ...sections, git: sections.git.prefault({}) });
}

export const HostConfigSchema = hostConfigSchema();
export type HostConfig = z.infer<typeof HostConfigSchema>;
export type RepoConfig = HostConfig["repos"][number];
export type EnvsConfig = NonNullable<HostConfig["envs"]>;

// The binaries a host config names, checked so a wrong path fails at load and not on the
// first launch. Windows takes `.exe` only: `.cmd`, `.bat` and `.ps1` go through an
// interpreter that re-parses the arguments.
export function checkHostBins(
  config: HostConfig,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
  extra: [string, string | undefined][] = [],
): string[] {
  const bins: [string, string | undefined][] = [
    ["terminals.shell", config.terminals.shell],
    ...Object.entries(config.terminals.bins).map(([k, v]): [string, string] => [
      `terminals.bins.${k}`,
      v,
    ]),
    ["terminals.editor", config.terminals.editor],
    ["envs.bin", config.envs?.bin],
    ...extra,
    ["git.bin", config.git.bin],
  ];
  const problems: string[] = [];
  for (const [key, path] of bins) {
    if (!path) continue;
    if (platform === "win32" && !path.toLowerCase().endsWith(".exe"))
      problems.push(`${key}: ${path} is not an .exe`);
    else if (!exists(path)) problems.push(`${key}: ${path} does not exist`);
  }
  return problems;
}

// Reads config.json with `schema`; development points the app at the dev API port.
export function readConfig<S extends z.ZodType>(
  path: string,
  schema: S,
  check: (config: z.infer<S>) => string[],
): z.infer<S> {
  const raw = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const parsed = schema.safeParse(
    process.env.NODE_ENV === "development"
      ? { ...raw, port: DEV_API_PORT, remote: { enabled: false } }
      : raw,
  );
  if (!parsed.success) {
    throw new Error(`Invalid ${path}:\n${z.prettifyError(parsed.error)}`);
  }
  const problems = check(parsed.data);
  if (problems.length > 0) throw new Error(`Invalid ${path}:\n${problems.join("\n")}`);
  return parsed.data;
}

export function loadHostConfig(path = join(DATA_DIR, "config.json")): HostConfig {
  return readConfig(path, HostConfigSchema, (c) => checkHostBins(c));
}
