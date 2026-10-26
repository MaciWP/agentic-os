#!/usr/bin/env bun
// The rituals in the user's own prompts: what they type again and again, as templates the
// «Minar rituales» saved prompt turns into work bar drafts. Claude transcripts only.
//
//   bun scripts/mine-rituals.ts [projects dir]   (default ~/.claude/projects)
//
// Prints JSON with two lists. `rituals`: the prompts that read the same once tickets, paths,
// URLs and numbers are taken out, seen at least MIN_PROMPTS times in MIN_SESSIONS sessions.
// `candidates`: every other distinct prompt seen in two sessions or among the newest, for the
// agent to group by meaning. The first run (2026-10-12, 1243 typed prompts, median 28 words)
// found a single exact group, so the paraphrases are the agent's job, not a regex's.
// ponytail: Claude transcripts only; add Codex/Grok when a ritual lives mostly there.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MIN_WORDS = 4;
export const MIN_PROMPTS = 3;
export const MIN_SESSIONS = 2;
const SAMPLE_CHARS = 200;
const SAMPLES = 2;
// Room for the agent: about 50 KB of candidates.
export const MAX_CANDIDATES = 200;
export const RECENT = 150;

// Prompts the app writes itself (kickoff, launch and review headers) are not the user's ritual.
const APP =
  /^(Kickoff:|Work on Jira ticket|Review GitHub pull request|Review the implementation of Jira ticket|Follow these instructions\.|Context: (Jira ticket|GitHub pull request))/;

export type Ritual = {
  template: string;
  count: number;
  sessions: number;
  lastSeen: string;
  samples: string[];
};
export type Mined = { rituals: Ritual[]; candidates: Ritual[] };

type Typed = { text: string; session: string; at: string };

// The text the user typed on one transcript line, or null for tool results, commands, meta
// lines, compaction summaries, side chains and anything the app wrote.
export function typedText(line: string): Typed | null {
  if (!line.includes('"type":"user"')) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(line);
  } catch {
    return null;
  }
  if (j.type !== "user" || j.isSidechain || j.isMeta || j.isCompactSummary) return null;
  const origin = j.origin as { kind?: string } | undefined;
  const human = origin?.kind === "human" || j.promptSource === "typed";
  const content = (j.message as { content?: unknown } | undefined)?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((b) => b?.type === "text" && typeof b.text === "string")
            .map((b) => b.text as string)
            .join("\n")
        : "";
  if (!human || !text.trim()) return null;
  if (/^<(command-|local-command)|<task-notification>|^This session is being continued/.test(text))
    return null;
  if (APP.test(text.trim())) return null;
  const session = typeof j.sessionId === "string" ? j.sessionId : "";
  const at = typeof j.timestamp === "string" ? j.timestamp : "";
  return session && at ? { text, session, at } : null;
}

// The prompt with what changes between runs taken out: pasted blocks dropped, ticket keys,
// URLs, paths and numbers as placeholders, lower case, one space between words.
export function templateOf(text: string): string {
  return text
    .replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, " ")
    .replace(/\[Image #\d+\]/g, " ")
    .replace(/https?:\/\/\S+/g, " {{url}} ")
    .replace(/\b[A-Z][A-Z0-9_]+-\d+\b/g, " {{ticket}} ")
    .replace(/(?:~|\.{1,2})?(?:\/[\w.@-]+)+\/?/g, " {{path}} ")
    .replace(/\b\d+(?:[.,:]\d+)*\b/g, " {{n}} ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const words = (template: string) => template.split(" ").filter((w) => !/^\{\{\w+\}\}$/.test(w));

const sample = (text: string) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > SAMPLE_CHARS ? `${one.slice(0, SAMPLE_CHARS - 1)}…` : one;
};

// The rituals and candidates in transcript lines, the same output for the same lines in any
// order.
export function mine(lines: Iterable<string>): Mined {
  const groups = new Map<string, Typed[]>();
  for (const line of lines) {
    const typed = typedText(line);
    if (!typed) continue;
    const template = templateOf(typed.text);
    if (words(template).length < MIN_WORDS) continue;
    const group = groups.get(template) ?? [];
    group.push(typed);
    groups.set(template, group);
  }
  const all = [...groups].map(([template, typed]): Ritual => {
    // Newest first; ties by text, so the samples do not depend on the reading order.
    const sorted = typed.sort((a, b) => b.at.localeCompare(a.at) || a.text.localeCompare(b.text));
    return {
      template,
      count: typed.length,
      sessions: new Set(typed.map((t) => t.session)).size,
      lastSeen: sorted[0]?.at ?? "",
      samples: [...new Set(sorted.map((t) => sample(t.text)))].slice(0, SAMPLES),
    };
  });
  const byCount = (a: Ritual, b: Ritual) =>
    b.count - a.count ||
    b.lastSeen.localeCompare(a.lastSeen) ||
    a.template.localeCompare(b.template);
  const ritual = (r: Ritual) => r.count >= MIN_PROMPTS && r.sessions >= MIN_SESSIONS;
  const recent = new Set(
    [...all]
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || a.template.localeCompare(b.template))
      .slice(0, RECENT),
  );
  return {
    rituals: all.filter(ritual).sort(byCount),
    candidates: all
      .filter((r) => !ritual(r) && (r.sessions >= MIN_SESSIONS || recent.has(r)))
      .sort(byCount)
      .slice(0, MAX_CANDIDATES)
      .map((r) => ({ ...r, samples: r.samples.slice(0, 1) })),
  };
}

// Every line of every transcript under the projects folder, one file at a time.
function* transcriptLines(root: string): Generator<string> {
  for (const project of readdirSync(root).sort()) {
    const dir = join(root, project);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith(".jsonl")) continue;
      yield* readFileSync(join(dir, file), "utf8").split("\n");
    }
  }
}

if (import.meta.main) {
  const root = process.argv[2] ?? join(homedir(), ".claude", "projects");
  console.log(JSON.stringify(mine(transcriptLines(root)), null, 2));
}
