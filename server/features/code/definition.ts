import { dirname, join, posix } from "node:path";
import { runGit } from "../git/run.ts";
import { below, type CodeWhere, confine, repoTop } from "./read.ts";

// Go to definition without a language server: `git grep` for the lines that declare a name,
// in the repo that holds the open file. Close to right for the usual cases (a function, a
// class, a type, a const, a method, a def) and cheap; a name declared in several places
// comes back as a ranked list, never as a silent wrong jump. ponytail: grep heuristic, not
// a language server; upgrade to tsserver for TS if misses are reported.

export const NAME = /^[A-Za-z_$][\w$]{0,127}$/;
export const DEFINITION_LIMIT = 30;
const PER_FILE = 5;
const TIMEOUT_MS = 5000;
const OUT_BYTES = 1024 * 1024;
const PREVIEW = 200;

export type Definition = { path: string; line: number; text: string };

// POSIX ERE, which every git build has (PCRE is optional). A name is only [\w$], so `$` is the
// one character to escape.
const after = "([^A-Za-z0-9_$]|$)";
const KEYWORDS =
  "function\\*?|class|interface|type|enum|namespace|module|const|let|var|def|fn|struct|trait|func|macro_rules!";
const MODIFIERS =
  "export|default|declare|public|private|protected|static|async|override|readonly|get|set|abstract|pub(\\([a-z]+\\))?|unsafe|extern";
const START = `^[[:space:]]*((${MODIFIERS})[[:space:]]+)*`;

// Every pattern starts at the start of a line, so a declaration quoted in a string or named
// in a comment is not one. Declarations by a keyword first; methods, arrow properties and
// Python's module assignments after them, since those patterns also catch a few calls.
export function patterns(name: string) {
  const n = name.replaceAll("$", "\\$");
  return {
    strong: [
      `${START}(${KEYWORDS})[[:space:]]+${n}${after}`,
      `^[[:space:]]*func[[:space:]]*\\([^)]*\\)[[:space:]]*${n}[[:space:]]*\\(`,
    ],
    weak: [
      `${START}${n}[[:space:]]*(<[^>]*>)?\\([^)]*\\)[^;]*\\{[[:space:]]*$`,
      `${START}${n}[[:space:]]*[:=][[:space:]]*(async[[:space:]]+)?(function|\\([^)]*\\)[^=;]*=>|[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*=>)`,
      `^${n}[[:space:]]*(:[^=]*)?=[^=]`,
    ],
  };
}

// `path\0line\0text\n` per hit, as `git grep --null -n` writes them.
export function parseGrep(out: string): Definition[] {
  const hits: Definition[] = [];
  for (const row of out.split("\n")) {
    const [path, line, ...rest] = row.split("\0");
    const n = Number(line);
    if (!path || !Number.isInteger(n) || n < 1) continue;
    hits.push({ path, line: n, text: rest.join("\0").trim().slice(0, PREVIEW) });
  }
  return hits;
}

// The open file's hits first, then its folder's, then the rest by path; keyword ones lead.
export function rank(hits: (Definition & { strong: boolean })[], from: string): Definition[] {
  const folder = posix.dirname(from);
  const near = (h: Definition) => (h.path === from ? 0 : posix.dirname(h.path) === folder ? 1 : 2);
  const seen = new Set<string>();
  return hits
    .sort(
      (a, b) =>
        Number(b.strong) - Number(a.strong) ||
        near(a) - near(b) ||
        a.path.localeCompare(b.path) ||
        a.line - b.line,
    )
    .filter((h) => {
      const key = `${h.path}:${h.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, DEFINITION_LIMIT)
    .map(({ path, line, text }) => ({ path, line, text }));
}

export async function findDefinition(
  where: CodeWhere,
  from: string,
  name: string,
): Promise<{ hits: Definition[]; git: boolean }> {
  const { bin, env } = where;
  const { base, rel, path } = await confine(where.cwd, from);
  const top = bin ? await repoTop(where, base, dirname(path)) : null;
  if (!bin || !top) return { hits: [], git: false };
  const grep = async (set: string[]) => {
    const args = ["grep", "-n", "-I", "-E", "--null", "--no-color", "--untracked"];
    args.push("--max-count", String(PER_FILE), ...set.flatMap((p) => ["-e", p]));
    // Exit 1: no line matched.
    const { out } = await runGit(bin, top, args, {
      env,
      ok: [0, 1],
      timeoutMs: TIMEOUT_MS,
      maxBytes: OUT_BYTES,
    });
    // Paths come relative to the repo; the tile speaks the checkout's.
    return parseGrep(out).flatMap((h) => {
      const p = below(base, join(top, h.path));
      return p === null ? [] : [{ ...h, path: p }];
    });
  };
  const { strong, weak } = patterns(name);
  const [s, w] = await Promise.all([grep(strong), grep(weak)]);
  const hits = [
    ...s.map((h) => ({ ...h, strong: true })),
    ...w.map((h) => ({ ...h, strong: false })),
  ];
  return { hits: rank(hits, rel), git: true };
}
