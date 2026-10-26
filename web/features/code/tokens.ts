import { getSingletonHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import darkPlus from "shiki/themes/dark-plus.mjs";
import { type Lang, langName, langOf, loadGrammar } from "./languages.ts";

// VS Code's grammars in its Dark+ colours, through Shiki, with its bracket pair colours on
// top. The viewer paints a whole file in the highlight worker (highlight.worker.ts), never on
// the page's thread: a 1 000-line TSX file takes 130–630 ms in V8 and 50–350 ms in
// JavaScriptCore. The editor (monaco.ts) asks the same highlighter on the page, a line at a
// time, as Monaco needs them. The JavaScript
// regex engine, not Oniguruma's WASM: the page's CSP runs no WASM (server/static.ts).
// `forgiving` skips the odd pattern that engine cannot run instead of failing the whole file.
// The regex target depends on the engine, because neither is right on both (measured
// 2026-10-09). JavaScriptCore (Safari, and Bun in tests) runs the `v` flag of ES2024+ wrong in
// 1 call of 3–6 at random (`42; // why` all as a number); on ES2018 it was right 60 times of
// 60. V8 is right on its default target, while on ES2018 a YAML comment with any non-ASCII
// character (`# año`) takes the string colour.

// Past these a file stays plain: its spans would be too many for the page to draw quickly.
export const HIGHLIGHT_LINES = 5000;
export const HIGHLIGHT_BYTES = 300_000;
export const THEME = "dark-plus";
const HEAD = 1024;

export type Token = { content: string; color?: string; fontStyle?: number };
// `tokens` null: plain text, because no grammar knows the file or it is past the caps.
export type Painted = { lang: Lang | null; name: string; tokens: Token[][] | null };

const TARGET = /Chrome\/|Firefox\//.test(globalThis.navigator?.userAgent ?? "") ? "auto" : "ES2018";

export const highlighter = () =>
  getSingletonHighlighterCore({
    themes: [darkPlus],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true, target: TARGET }),
  });

// One load per grammar, however many files ask for it at once.
const loading = new Map<Lang, Promise<void>>();
export const load = (lang: Lang) => {
  const known = loading.get(lang);
  if (known) return known;
  const next = (async () => {
    const h = await highlighter();
    await h.loadLanguage(await loadGrammar(lang));
  })();
  next.catch(() => loading.delete(lang));
  loading.set(lang, next);
  return next;
};

// VS Code's default bracket pair colours, by depth.
export const BRACKET_COLOURS = ["#FFD700", "#DA70D6", "#179FFF"] as const;
const OPEN = "([{";
const CLOSE = ")]}";
const BRACKET = /[()[\]{}]/;

// Brackets in code take their pair's colour by depth across the file; those in strings and
// comments keep their colour, since only tokens in the theme's plain colour are code
// punctuation. A closing bracket with nothing open stays as it was.
export function colourBrackets(lines: Token[][], plain: string): Token[][] {
  const base = plain.toLowerCase();
  let depth = 0;
  return lines.map((line) =>
    line.flatMap((t) => {
      if ((t.color && t.color.toLowerCase() !== base) || !BRACKET.test(t.content)) return [t];
      const out: Token[] = [];
      let run = "";
      const flush = () => {
        if (run) out.push({ ...t, content: run });
        run = "";
      };
      for (const ch of t.content) {
        if (OPEN.includes(ch)) {
          flush();
          out.push({ ...t, content: ch, color: BRACKET_COLOURS[depth % 3] });
          depth++;
        } else if (CLOSE.includes(ch) && depth > 0) {
          flush();
          depth--;
          out.push({ ...t, content: ch, color: BRACKET_COLOURS[depth % 3] });
        } else run += ch;
      }
      flush();
      return out;
    }),
  );
}

// One text's lines as coloured tokens. Only colour and style come from the theme; the
// background and the font stay the app's.
export async function tokenize(text: string, lang: Lang): Promise<Token[][]> {
  await load(lang);
  const h = await highlighter();
  const lines = h
    .codeToTokensBase(text, { lang, theme: THEME })
    .map((line) =>
      line.map((t) => ({ content: t.content, color: t.color, fontStyle: t.fontStyle })),
    );
  return colourBrackets(lines, h.getTheme(THEME).fg);
}

// A file's grammar, its name and its tokens, from its path and text.
export async function paint(path: string, text: string): Promise<Painted> {
  const lang = langOf(path, text.slice(0, HEAD));
  if (!lang) return { lang: null, name: "Texto", tokens: null };
  const name = langName(lang);
  const big = text.length > HIGHLIGHT_BYTES || text.split("\n").length > HIGHLIGHT_LINES;
  return { lang, name, tokens: big ? null : await tokenize(text, lang) };
}
