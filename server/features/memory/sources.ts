import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { FRONTMATTER, frontmatterFields } from "../../../shared/work-bar.ts";

// Where the Markdown the app shows lives. Harness memories are read-only; only the app's
// own folders under data/ can be written, and only through notes.ts.

export type SourceId =
  | "notes"
  | "memory"
  | "prompts"
  | "claude-memory"
  | "claude-md"
  | "codex"
  | "grok";

type Root =
  // Every *.md under dir (no symlinks, no dotfiles), listed as <prefix><relative path>.
  | { kind: "tree"; dir: string; prefix: string }
  // One named file; a symlinked file is followed (~/.claude/CLAUDE.md usually is one).
  | { kind: "file"; path: string; rel: string };

export type Source = {
  id: SourceId;
  label: string;
  writable: boolean;
  roots: () => Promise<Root[]>;
};

export type Entry = {
  id: string;
  source: SourceId;
  rel: string;
  path: string;
  follow: boolean;
  mtime: number;
  size: number;
};

export type SourceRoots = {
  home: string;
  dataDir: string;
  repos: { id: string; localPath: string }[];
};

export const MAX_DOC_BYTES = 1 << 20;
const MAX_PER_SOURCE = 2000;
const MAX_DEPTH = 6;
export const WRITABLE: SourceId[] = ["notes", "memory", "prompts"];

async function subdirs(dir: string): Promise<string[]> {
  const items = await readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[]);
  return items.filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name);
}

export function memorySources({ home, dataDir, repos }: SourceRoots): Source[] {
  const tree = (dir: string, prefix = "") => ({ kind: "tree" as const, dir, prefix });
  const file = (path: string, rel: string) => ({ kind: "file" as const, path, rel });
  const app = (id: SourceId, label: string): Source => ({
    id,
    label,
    writable: true,
    roots: async () => [tree(join(dataDir, id))],
  });
  return [
    app("notes", "Notas"),
    app("memory", "Memoria de la app"),
    app("prompts", "Prompts"),
    {
      id: "claude-memory",
      label: "Claude Code · memoria",
      writable: false,
      roots: async () => {
        const projects = join(home, ".claude", "projects");
        return (await subdirs(projects)).map((p) => tree(join(projects, p, "memory"), `${p}/`));
      },
    },
    {
      id: "claude-md",
      label: "Claude Code · CLAUDE.md",
      writable: false,
      roots: async () => [
        file(join(home, ".claude", "CLAUDE.md"), "global/CLAUDE.md"),
        ...repos
          .filter((r) => isAbsolute(r.localPath))
          .map((r) => file(join(r.localPath, "CLAUDE.md"), `${r.id}/CLAUDE.md`)),
      ],
    },
    {
      id: "codex",
      label: "Codex",
      writable: false,
      roots: async () => [
        file(join(home, ".codex", "AGENTS.md"), "AGENTS.md"),
        tree(join(home, ".codex", "memories"), "memories/"),
      ],
    },
    {
      id: "grok",
      label: "Grok",
      writable: false,
      roots: async () => [
        tree(join(home, ".grok", "memory"), "memory/"),
        tree(join(home, ".grok", "memory-v2"), "memory-v2/"),
      ],
    },
  ];
}

// Writable sources are flat: their notes are direct children of the folder.
async function walkTree(
  root: { dir: string; prefix: string },
  maxDepth: number,
  out: Omit<Entry, "id" | "source">[],
): Promise<boolean> {
  const rec = async (dir: string, rel: string, depth: number): Promise<boolean> => {
    let items: Dirent[];
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const d of items) {
      if (out.length >= MAX_PER_SOURCE || d.name.startsWith(".")) continue;
      const path = join(dir, d.name);
      // Dirent types come from lstat: a symlink is neither a directory nor a file here.
      if (d.isDirectory() && depth < maxDepth) await rec(path, `${rel}${d.name}/`, depth + 1);
      else if (d.isFile() && d.name.endsWith(".md")) {
        const s = await stat(path).catch(() => null);
        if (s && s.size <= MAX_DOC_BYTES)
          out.push({
            rel: `${root.prefix}${rel}${d.name}`,
            path,
            follow: false,
            mtime: s.mtimeMs,
            size: s.size,
          });
      }
    }
    return true;
  };
  return rec(root.dir, "", 0);
}

// Lists a source's documents (stat only). `found` is false when none of its roots exist.
export async function walkSource(source: Source): Promise<{ entries: Entry[]; found: boolean }> {
  const out: Omit<Entry, "id" | "source">[] = [];
  let found = false;
  for (const root of await source.roots()) {
    if (root.kind === "tree") {
      if (await walkTree(root, source.writable ? 0 : MAX_DEPTH, out)) found = true;
    } else {
      const s = await stat(root.path).catch(() => null);
      if (s?.isFile() && s.size <= MAX_DOC_BYTES) {
        found = true;
        out.push({ rel: root.rel, path: root.path, follow: true, mtime: s.mtimeMs, size: s.size });
      }
    }
  }
  return {
    entries: out.map((e) => ({ ...e, id: `${source.id}:${e.rel}`, source: source.id })),
    found,
  };
}

// The document without its leading frontmatter block.
export const stripFrontmatter = (text: string) => text.replace(FRONTMATTER, "");

// Title and description: top-level frontmatter keys, else the first heading, else the name.
export function describeDoc(
  text: string,
  rel: string,
): { title: string; description: string | null } {
  const fields = frontmatterFields(text);
  let title = fields.find(([k]) => k === "name" || k === "title")?.[1];
  const description = fields.find(([k]) => k === "description")?.[1];
  const body = stripFrontmatter(text);
  title ??= /^#{1,3}[ \t]+(.+)$/m.exec(body)?.[1]?.trim();
  return {
    title: (title || basename(rel, ".md")).slice(0, 200),
    description: description ? description.slice(0, 400) : null,
  };
}
