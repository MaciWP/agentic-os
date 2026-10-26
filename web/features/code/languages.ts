import { bundledLanguagesInfo } from "shiki/langs";

// Which of Shiki's grammars reads a file: every grammar it bundles (VS Code's own, ~240), each
// loaded the first time a file needs it. This module runs in the highlight worker, so the
// page itself never loads Shiki's catalogue.

export type Lang = string;

const INFO = new Map(bundledLanguagesInfo.map((i) => [i.id, i]));
// A grammar's id and aliases double as file extensions: ts, py, rs, yml, hbs, ps1, cmd…
const BY_ALIAS = new Map<string, Lang>(
  bundledLanguagesInfo.flatMap((i) => [i.id, ...(i.aliases ?? [])].map((a) => [a, i.id])),
);

// Extensions no grammar names as an alias.
const BY_EXT: Record<string, Lang> = {
  h: "c",
  hh: "cpp",
  pyi: "python",
  svg: "xml",
  plist: "xml",
  xaml: "xml",
  iml: "xml",
  csproj: "xml",
  patch: "diff",
  cfg: "ini",
  conf: "ini",
  command: "shellscript",
  psm1: "powershell",
  gradle: "groovy",
  mk: "make",
  ipynb: "json",
  webmanifest: "json",
  "code-workspace": "jsonc",
};

// Names that say more than their extension (or have none).
const BY_NAME: Record<string, Lang> = {
  dockerfile: "docker",
  makefile: "make",
  gnumakefile: "make",
  gemfile: "ruby",
  rakefile: "ruby",
  vagrantfile: "ruby",
  jenkinsfile: "groovy",
  "cmakelists.txt": "cmake",
  codeowners: "codeowners",
  ".zshrc": "shellscript",
  ".zprofile": "shellscript",
  ".bashrc": "shellscript",
  ".bash_profile": "shellscript",
  ".profile": "shellscript",
  ".editorconfig": "ini",
  ".gitmodules": "ini",
  ".gitconfig": "ini",
  ".flake8": "ini",
  ".npmrc": "ini",
  ".pylintrc": "ini",
  // JSON with comments, as the tools that read them allow.
  ".eslintrc": "jsonc",
  ".babelrc": "jsonc",
  ".swcrc": "jsonc",
  "devcontainer.json": "jsonc",
  "biome.json": "jsonc",
  "bun.lock": "jsonc",
  ".prettierrc": "json",
};

// `#!/usr/bin/env bun`, `#!/bin/sh`…: the interpreter names the language of a script.
const SHEBANG: [RegExp, Lang][] = [
  [/\b(bun|deno|tsx|ts-node)\b/, "typescript"],
  [/\bnode\b/, "javascript"],
  [/\b(ba|z|k|da|a)?sh\b/, "shellscript"],
  [/\bpython[\d.]*\b/, "python"],
  [/\bruby\b/, "ruby"],
  [/\bperl\b/, "perl"],
  [/\bfish\b/, "fish"],
  [/\bphp\b/, "php"],
  [/\blua\b/, "lua"],
];

// Django and Jinja templates are .html with `{% … %}` or `{{ … }}` in them. Shiki ships their
// grammar, jinja-html (the tags and the HTML around them), only inside "jinja".
const TEMPLATE = /\{%|\{\{/;
const HOSTED: Record<string, { in: Lang; name: string }> = {
  "jinja-html": { in: "jinja", name: "Jinja HTML" },
};

// The grammar for a file from its path and, when given, the start of its text; null is plain
// text. By name, then by extension, then by its shebang.
export function langOf(path: string, head = ""): Lang | null {
  const name = (path.split("/").pop() ?? "").toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  if (/^[tj]sconfig(\..+)?\.json$/.test(name)) return "jsonc";
  if (/(^|\/)\.vscode\/[^/]+\.json$/i.test(path)) return "jsonc";
  if (name === ".env" || name.startsWith(".env.")) return "dotenv";
  if (name.startsWith("dockerfile.")) return "docker";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  const byExt = ext ? (BY_EXT[ext] ?? BY_ALIAS.get(ext) ?? null) : null;
  if (byExt === "html" && TEMPLATE.test(head)) return "jinja-html";
  if (byExt) return byExt;
  const first = head.startsWith("#!") ? (head.split("\n", 1)[0] ?? "") : "";
  return first ? (SHEBANG.find(([re]) => re.test(first))?.[1] ?? null) : null;
}

// The grammar's own name for a header: "TypeScript", "Shell", "Jinja HTML".
export const langName = (lang: Lang) => HOSTED[lang]?.name ?? INFO.get(lang)?.name ?? lang;

export async function loadGrammar(lang: Lang) {
  const info = INFO.get(HOSTED[lang]?.in ?? lang);
  if (!info) throw new Error(`No grammar for ${lang}`);
  return (await info.import()).default;
}
