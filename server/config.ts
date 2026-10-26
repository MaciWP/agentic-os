import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { MachineConfig, RemoteConfig } from "../shared/access.ts";
import { ProjectColor } from "../shared/project-colors.ts";
import {
  checkHostBins,
  DATA_DIR,
  hostSections,
  type RepoConfig,
  readConfig,
} from "./config-host.ts";

export { APP_ROOT, DATA_DIR, type EnvsConfig, type RepoConfig } from "./config-host.ts";

// A call's prompt over this many tokens bills at a model's `over100k` rates.
export const LONG_PROMPT = 100_000;
const RatesSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  // Claude's one-hour cache; the five-minute price when left out.
  cacheWrite1h: z.number().nonnegative().optional(),
});

// The server's schema: the host's sections (config-host.ts) plus every page's.
export function configSchema(platform: NodeJS.Platform = process.platform) {
  const { absolute, mac, sections } = hostSections(platform);

  return z
    .object({
      ...sections,
      devPort: z.number().int().default(5173),
      // A worker is a second machine the hub (the Mac) drives: terminals, repos, files and git
      // only. It skips the Mac-only background work (agent discovery, keep-awake, usage ingest,
      // clipboard). Providers stay config-driven: a worker's config leaves them off.
      role: z.enum(["hub", "worker"]).default("hub"),
      // A disabled provider keeps its routes, which answer { disabled: true }.
      // Jira defaults to on when its section is present. Google (personal Gmail and Calendar
      // for the «Hoy» page) is off until asked for: its app credentials live in the Keychain.
      // Outlook (work mail and calendar through the Mac's Exchange account and
      // AgenticMac.app) is off until asked for too.
      providers: z
        .object({
          jira: z.boolean().optional(),
          github: z.boolean().default(true),
          google: z.boolean().default(false),
          outlook: z.boolean().default(false),
        })
        .prefault({}),
      jira: z
        .object({
          site: z.url(),
          project: z.string().min(1),
          // The callback registered in the Atlassian app. Only the server on its port can
          // finish a login; any other port refuses to start one.
          callbackUrl: z.url().default("http://localhost:4317/auth/atlassian/callback"),
          // Custom field ids. `reviewer` is a multi-user picker; without it the board shows no
          // reviewers and «Revisar yo» cannot write to Jira.
          fields: z
            .object({
              points: z.string().optional(),
              size: z.string().optional(),
              reviewer: z.string().optional(),
            })
            .prefault({}),
          // The Jira boards the Tickets page mirrors, the first one by default: its own JQL
          // restriction and its columns, each with its status ids as the board settings list
          // them. Ids, not names: Jira returns names in the user's language, and JQL matches
          // the untranslated ones.
          // ponytail: copied by hand from the board settings; when they drift a second time,
          // read /rest/agile/1.0/board/{id}/configuration (needs Jira Software scopes).
          boards: z
            .array(
              z.object({
                id: z.string().regex(/^[a-z0-9-]+$/, "lowercase letters, digits and dashes"),
                name: z.string().min(1),
                jql: z.string().min(1).optional(),
                columns: z
                  .array(
                    z.object({
                      name: z.string().min(1),
                      statuses: z.array(z.string().regex(/^\d+$/, "a status id")).min(1),
                    }),
                  )
                  .min(1),
              }),
            )
            .default([])
            .refine((b) => new Set(b.map((x) => x.id)).size === b.length, "board ids repeat"),
        })
        .optional(),
      notesDir: z.string().optional(),
      // A project's tag colour, by the name it shows (a repo's group, else the repo's id); a
      // project left out takes one picked by its name.
      projectColors: z.record(z.string().min(1), ProjectColor).default({}),
      // Dollars per million tokens, by model id or a prefix of it (the longest wins), for the
      // usage page's API-equivalent cost. A model with no price shows no cost.
      pricing: z
        .record(
          z.string().min(1),
          RatesSchema.extend({
            // The whole call's rates when its prompt (input and cache) is over LONG_PROMPT
            // tokens, as Haiku 5.5 bills; the same rates at any length when left out.
            // ponytail: one threshold for every model; a field of its own if one bills another.
            over100k: RatesSchema.optional(),
          }),
        )
        .default({}),
      github: z
        .object({ bin: mac ? absolute.default("/opt/homebrew/bin/gh") : absolute.optional() })
        .prefault({}),
      git: sections.git
        .extend({
          // "Actualizar repos" on a timer, every N minutes; 0 is off.
          autoUpdateMinutes: z
            .number()
            .int()
            .min(0)
            .max(24 * 60)
            .default(0),
        })
        .prefault({}),
      remote: RemoteConfig.prefault({}),
      // Workers this hub drives; empty on a worker and on a single machine.
      machines: z
        .array(MachineConfig)
        .max(8)
        .refine((m) => new Set(m.map((x) => x.id)).size === m.length, "machine ids must differ")
        .default([]),
      usage: z
        .object({
          // The effort judge's Monday pass (features/usage/judge.ts), which spends up to its
          // budget on Sonnet. Off by default, so a server with its own data (the e2e one, which
          // reads the real Log Pose files) never buys one.
          judgeAuto: z.boolean().default(false),
        })
        .prefault({}),
      system: z
        .object({
          // Keep the screen on, so it never locks, while any agent works. Off: the lock a
          // managed Mac puts after some idle minutes is a security policy; the indicator's
          // timed switch is the usual way past it.
          screenWhileAgentsWork: z.boolean().default(false),
        })
        .prefault({}),
      // The image history: the screenshots folder is the OS's unless set here.
      images: z
        .object({
          screenshotsDir: absolute.optional(),
          // Every image copied anywhere joins the history. Off: a clipboard reader is what
          // endpoint protection looks for.
          watchClipboard: z.boolean().default(false),
          // ⌃⌘4 anywhere on the Mac captures into the terminal focused last (a resident
          // AgenticCapture.app; server/features/images/hotkey.ts).
          captureHotkey: z.boolean().default(true),
        })
        .prefault({}),
      // Dictation into terminals. Off until `model` names the folder of the speech model
      // (sherpa-onnx Parakeet V3 int8); the button then says how to turn it on.
      voice: z
        .object({
          model: absolute.optional(),
          // The model leaves memory after this long without a dictation.
          idleMinutes: z.number().int().min(1).max(240).default(10),
          // Words the model gets wrong, as heard and as meant: { "use query": "useQuery" }.
          replace: z.record(z.string().min(1).max(80), z.string().max(80)).default({}),
          // Words the model should expect, as written: names, identifiers. The targets of
          // `replace` and the Jira key join them on their own.
          terms: z.array(z.string().min(1).max(80)).max(200).default([]),
          // How hard Parakeet leans towards those words; higher finds more and invents more.
          // 0 (the default) turns the glossary off until the test set shows it helps.
          boost: z.number().min(0).max(20).default(0),
          // Keeps every dictation in data/voice-eval to compare engines on the user's voice.
          evalCapture: z.boolean().default(false),
          // The browser's echo cancellation, noise suppression and gain control.
          browserProcessing: z.boolean().default(true),
          // The microphone stays open this long after a dictation, so the next one starts at once
          // and keeps the half second before the keys. 0: open only while recording.
          warmSeconds: z.number().int().min(0).max(300).default(30),
        })
        .prefault({}),
      // Meeting transcripts (docs/transcripts.md): the three sherpa-onnx models they need, and the
      // app whose audio is captured. Recording stays off until all three paths are set.
      transcripts: z
        .object({
          // Silero VAD (silero_vad.onnx).
          vad: absolute.optional(),
          // pyannote segmentation 3.0 (model.onnx or model.int8.onnx).
          segmentation: absolute.optional(),
          // A speaker-embedding model (3D-Speaker ERes2Net).
          embedding: absolute.optional(),
          // The meeting app whose audio is the "system" track.
          bundle: z.string().min(1).default("com.microsoft.teams2"),
        })
        .prefault({}),
    })
    .superRefine((c, ctx) => {
      if (c.providers.jira && !c.jira)
        ctx.addIssue({
          code: "custom",
          path: ["jira"],
          message: "providers.jira is on: add the jira section",
        });
      if (c.providers.github && !c.github.bin)
        ctx.addIssue({
          code: "custom",
          path: ["github", "bin"],
          message: "providers.github is on: set github.bin",
        });
    })
    .transform(({ providers, ...c }) => {
      const jira = providers.jira ?? Boolean(c.jira);
      // Dropping the section makes every `config.jira` check mean "Jira is on".
      return {
        ...c,
        jira: jira ? c.jira : undefined,
        providers: {
          jira,
          github: providers.github,
          google: providers.google,
          outlook: providers.outlook,
        },
      };
    });
}

export const ConfigSchema = configSchema();
export type Config = z.infer<typeof ConfigSchema>;
export type GithubRepo = RepoConfig & { owner: string; name: string; login: string };

// The repos the GitHub provider reads: local-only repos have no owner, name or login.
export const onGithub = (r: RepoConfig): r is GithubRepo => Boolean(r.owner && r.name && r.login);

// Every binary the server may run, and the speech model, checked once at startup so a wrong
// path fails here and not on the first launch.
export function checkBins(
  config: Config,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string[] {
  const problems = checkHostBins(config, platform, exists, [
    ["github.bin", config.providers.github ? config.github.bin : undefined],
    ["ai.engine.bin", config.ai?.engine?.bin],
  ]);
  const engine = config.ai?.engine;
  for (const [key, path] of [
    ["model", engine?.model],
    ["draft", engine?.draft],
    ["template", engine?.template],
  ] as const)
    if (path && !exists(path)) problems.push(`ai.engine.${key}: ${path} does not exist`);
  // The speech model is a folder, not a binary, but it fails the same way when it is moved.
  const model = config.voice.model;
  // Qwen3-ASR has a tokenizer folder instead of tokens.txt.
  if (model && !exists(join(model, "tokens.txt")) && !exists(join(model, "conv_frontend.onnx")))
    problems.push(`voice.model: ${model} has no tokens.txt`);
  for (const key of ["vad", "segmentation", "embedding"] as const) {
    const path = config.transcripts[key];
    if (path && !exists(path)) problems.push(`transcripts.${key}: ${path} does not exist`);
  }
  return problems;
}

export function loadConfig(path = join(DATA_DIR, "config.json")): Config {
  return readConfig(path, ConfigSchema, (c) => checkBins(c));
}
