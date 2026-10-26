import * as monaco from "monaco-editor/editor/editor.api";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import { EncodedTokenMetadata, INITIAL, type StateStack } from "shiki/textmate";
import "monaco-editor/features/bracketMatching/register";
import "monaco-editor/features/clipboard/register";
import "monaco-editor/features/codicon/register";
import "monaco-editor/features/comment/register";
import "monaco-editor/features/contextmenu/register";
import "monaco-editor/features/cursorUndo/register";
import "monaco-editor/features/dnd/register";
import "monaco-editor/features/find/register";
import "monaco-editor/features/folding/register";
import "monaco-editor/features/indentation/register";
import "monaco-editor/features/linesOperations/register";
import "monaco-editor/features/multicursor/register";
import "monaco-editor/features/readOnlyMessage/register";
import "monaco-editor/features/wordHighlighter/register";
import "monaco-editor/features/wordOperations/register";
import type { Lang } from "./languages.ts";
import { highlighter, load, THEME } from "./tokens.ts";

// VS Code's editor (Monaco) with the viewer's own colours: the same Shiki highlighter and
// grammars (tokens.ts), asked a line at a time as Monaco needs them. Only the editor's core
// and the features listed above load: no language services, no Monarch grammars.
// Not `@shikijs/monaco`: it wires every grammar once at start, while ours load the first time
// a file needs them, and its state check made every key re-read the rest of the file.

globalThis.MonacoEnvironment = { getWorker: () => new EditorWorker() };

export { monaco };
export const EDITOR_THEME = "agentic-dark";
// A line this long stays plain, and one that takes longer than this to read is cut there:
// Shiki runs on the page here, so no single line may hold it.
const MAX_LINE = 20_000;
const LINE_MS = 30;

// A grammar's state at the end of a line. Equal states let Monaco stop re-reading the lines
// below an edit.
class LineState implements monaco.languages.IState {
  constructor(readonly stack: StateStack) {}
  clone() {
    return this;
  }
  equals(other: monaco.languages.IState) {
    return other instanceof LineState && this.stack.equals(other.stack);
  }
}

// Each token is named by its theme colour and style (`c5.f1`): one theme rule per colour, so
// Monaco paints exactly the colour Shiki chose. A comment, string or regex says so too
// (`c7.f0.comment`): Monaco reads that from the name to leave their brackets uncoloured and
// their quotes unpaired.
const KINDS = ["", ".comment", ".string", ".regex"];
const scope = (meta: number) =>
  `c${EncodedTokenMetadata.getForeground(meta)}.f${EncodedTokenMetadata.getFontStyle(meta)}${
    KINDS[EncodedTokenMetadata.getTokenType(meta)] ?? ""
  }`;

const STYLES = ["italic", "bold", "underline", "strikethrough"] as const;
const fontStyle = (bits: number) => STYLES.filter((_, i) => bits & (1 << i)).join(" ");

// A CSS colour (the app's are oklch) as the hex Monaco's themes take.
function hex(css: string): string {
  const pen = document.createElement("canvas").getContext("2d");
  if (!pen) return "#1e1e1e";
  pen.fillStyle = css;
  pen.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = pen.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
const cssVar = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Each Shiki grammar with the brackets, comments and indent rules of Monaco's language of the
// same kind: what ⌘/, Enter and the bracket colours read. Only the configuration is taken;
// Monaco's own `register` would also install its Monarch grammar over ours.
type Conf = { conf: monaco.languages.LanguageConfiguration };
const TS = () => import("monaco-editor/languages/definitions/typescript/typescript");
const JS = () => import("monaco-editor/languages/definitions/javascript/javascript");
const HTML = () => import("monaco-editor/languages/definitions/html/html");
const CPP = () => import("monaco-editor/languages/definitions/cpp/cpp");
const CONF: Record<Lang, () => Promise<Conf>> = {
  typescript: TS,
  tsx: TS,
  javascript: JS,
  jsx: JS,
  html: HTML,
  "jinja-html": HTML,
  c: CPP,
  cpp: CPP,
  python: () => import("monaco-editor/languages/definitions/python/python"),
  yaml: () => import("monaco-editor/languages/definitions/yaml/yaml"),
  shellscript: () => import("monaco-editor/languages/definitions/shell/shell"),
  css: () => import("monaco-editor/languages/definitions/css/css"),
  scss: () => import("monaco-editor/languages/definitions/scss/scss"),
  markdown: () => import("monaco-editor/languages/definitions/markdown/markdown"),
  go: () => import("monaco-editor/languages/definitions/go/go"),
  rust: () => import("monaco-editor/languages/definitions/rust/rust"),
  java: () => import("monaco-editor/languages/definitions/java/java"),
  ruby: () => import("monaco-editor/languages/definitions/ruby/ruby"),
  php: () => import("monaco-editor/languages/definitions/php/php"),
  sql: () => import("monaco-editor/languages/definitions/sql/sql"),
  docker: () => import("monaco-editor/languages/definitions/dockerfile/dockerfile"),
  ini: () => import("monaco-editor/languages/definitions/ini/ini"),
  xml: () => import("monaco-editor/languages/definitions/xml/xml"),
};
// Any other grammar: brackets and quotes pair, nothing more.
const PAIRS: monaco.languages.LanguageConfiguration = {
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"', notIn: ["string"] },
  ],
};

async function tokensFor(lang: Lang): Promise<monaco.languages.TokensProvider> {
  const [conf] = await Promise.all([CONF[lang]?.().then((m) => m.conf) ?? PAIRS, load(lang)]);
  monaco.languages.setLanguageConfiguration(lang, conf);
  const grammar = (await highlighter()).getLanguage(lang);
  return {
    getInitialState: () => new LineState(INITIAL),
    tokenize(line, state) {
      const before = state as LineState;
      if (line.length >= MAX_LINE)
        return { endState: before, tokens: [{ startIndex: 0, scopes: "" }] };
      const read = grammar.tokenizeLine2(line, before.stack, LINE_MS);
      const tokens: monaco.languages.IToken[] = [];
      for (let i = 0; i < read.tokens.length; i += 2) {
        tokens.push({ startIndex: read.tokens[i] ?? 0, scopes: scope(read.tokens[i + 1] ?? 0) });
      }
      return { endState: new LineState(read.ruleStack), tokens };
    },
  };
}

// Dark+ as Shiki has it (the editor's own colours: selection, cursor, brackets), one rule per
// token colour and style, and the app's background so the editor sits in the tile like the
// viewer did.
async function defineTheme() {
  const h = await highlighter();
  const { colorMap } = h.setTheme(THEME);
  const rules = colorMap.flatMap((colour, i) => {
    if (!colour) return [];
    const foreground = colour.slice(1);
    return [
      { token: `c${i}`, foreground },
      ...[...Array(15).keys()].map((bit) => ({
        token: `c${i}.f${bit + 1}`,
        foreground,
        fontStyle: fontStyle(bit + 1),
      })),
    ];
  });
  const bg = hex(cssVar("--bg"));
  monaco.editor.defineTheme(EDITOR_THEME, {
    base: "vs-dark",
    inherit: false,
    rules,
    colors: {
      ...h.getTheme(THEME).colors,
      "editor.background": bg,
      "editorGutter.background": bg,
      "editorLineNumber.foreground": hex(cssVar("--ink-2")),
      "editor.lineHighlightBorder": "#00000000",
      "editor.lineHighlightBackground": `${hex(cssVar("--line"))}66`,
    },
  });
}

// The editor's theme, defined once; each grammar the first time a file in it opens.
const ready = { theme: null as Promise<void> | null, langs: new Set<Lang>() };

export async function prepare(lang: Lang | null): Promise<string> {
  ready.theme ??= defineTheme();
  await ready.theme;
  if (!lang) return "plaintext";
  if (!ready.langs.has(lang)) {
    ready.langs.add(lang);
    monaco.languages.register({ id: lang });
    monaco.languages.registerTokensProviderFactory(lang, { create: () => tokensFor(lang) });
  }
  return lang;
}
