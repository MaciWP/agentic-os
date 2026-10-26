import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { clip } from "./parsed.ts";

export type Source = {
  path: string;
  harness: "claude" | "codex" | "grok";
  sessionId: string;
  agent?: string;
  // Grok: the session folder's cwd, from its encoded name.
  cwd?: string;
};

async function list(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}

const SubagentMeta = z.looseObject({ agentType: z.string().min(1) });

export async function claudeSources(home: string): Promise<Source[]> {
  const root = join(home, ".claude", "projects");
  const out: Source[] = [];
  for (const project of await list(root)) {
    const dir = join(root, project);
    for (const name of await list(dir)) {
      if (name.endsWith(".jsonl")) {
        out.push({ path: join(dir, name), harness: "claude", sessionId: basename(name, ".jsonl") });
        continue;
      }
      // A Workflow run keeps its agents one level deeper, in `workflows/<run>/`.
      const subagents = join(dir, name, "subagents");
      const workflows = join(subagents, "workflows");
      const runs = (await list(workflows)).map((run) => join(workflows, run));
      for (const folder of [subagents, ...runs])
        for (const file of await list(folder)) {
          if (!/^agent-[\w-]+\.jsonl$/.test(file)) continue;
          const meta = await Bun.file(join(folder, file.replace(/\.jsonl$/, ".meta.json")))
            .json()
            .catch(() => null);
          const parsed = SubagentMeta.safeParse(meta);
          out.push({
            path: join(folder, file),
            harness: "claude",
            sessionId: name,
            agent: clip(parsed.success ? parsed.data.agentType : "subagent"),
          });
        }
    }
  }
  return out;
}

export async function codexSources(home: string): Promise<Source[]> {
  const root = join(home, ".codex", "sessions");
  const out: Source[] = [];
  for (const y of await list(root))
    for (const m of await list(join(root, y)))
      for (const d of await list(join(root, y, m)))
        for (const name of await list(join(root, y, m, d)))
          if (/^rollout-.*\.jsonl$/.test(name))
            out.push({ path: join(root, y, m, d, name), harness: "codex", sessionId: "" });
  return out;
}

export async function grokSources(home: string): Promise<Source[]> {
  const root = join(home, ".grok", "sessions");
  const out: Source[] = [];
  for (const folder of await list(root)) {
    let cwd: string;
    try {
      cwd = decodeURIComponent(folder);
    } catch {
      continue;
    }
    for (const id of await list(join(root, folder))) {
      const path = join(root, folder, id, "events.jsonl");
      if (await Bun.file(path).exists()) out.push({ path, harness: "grok", sessionId: id, cwd });
    }
  }
  return out;
}
