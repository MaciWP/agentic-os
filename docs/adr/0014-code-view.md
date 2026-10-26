# ADR 0014 — Code view

Status: accepted (2026-10-08). Scope: the Mesa's code tile and `/api/code`. Since 2026-10-09
the tile also edits: [ADR 0015](0015-code-editing.md) replaces points 1 (read only), 6
(«Formatear») and 7 (⌥←) on a desktop pointer; this ADR stays true for touch screens.

## Context

Reading a checkout meant leaving the app for an editor: to look at the folders an agent is
working in, at the whole file behind a git diff, or at where a function is defined. The
user wants that inside the Mesa, beside the terminals and git, as light as possible.

## Decision

1. **A panel tile, read only.** `code:<encoded location>` sits, moves, splits and counts
   against the six like a git tile (ADR 0006). A wide tile shows the tree and the file side
   by side; a narrow one shows one pane, with "Ficheros" back to the tree. It never writes:
   agents and the user's editor do that. (Superseded by ADR 0015: the tile edits and saves.)
2. **The server resolves the place; the client sends a location id and a relative path.**
   `server/place.ts` (shared with git) turns the id into a checkout. Every path is confined
   to it: a lexical check, then `realpath`, then the check again, so `..`, an absolute path
   and a symlink out are refused (403 `outside`). `.git` is never listed.
3. **Five GET routes, all `remote`** (`server/remote-routes.ts`), for the reason
   `/api/files/folders` and `/api/git/diff` are: a remote device already runs shells there.

   | Route | Answer | Caps |
   |---|---|---|
   | `/tree?location&dir` | One folder: folders first, then files; `ignored` from `git check-ignore` when the folder's repo sits inside the checkout | 2 000 entries |
   | `/file?location&path` | The text and its sha1, or `binary` (a NUL in the first 8 KB) or `too_large`; each with its `version`, the ETag | 1 MB |
   | `/raw?location&path` | An image's bytes, for the image views: only listed image extensions (else 415), `nosniff` and `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`, so an SVG opened on its own runs nothing in the app's origin | 20 MB |
   | `/files?location` | Every path git sees (`ls-files --cached --others --exclude-standard`), at an env root from each child repo | 50 000 paths |
   | `/definition?location&path&name` | Where `name` is declared | 30 hits, 5 s |

4. **Colours by Shiki on its JavaScript regex engine, Dark+, in a Web Worker.** The page's
   CSP (`script-src 'self' blob:`) has no `wasm-unsafe-eval`, so the Oniguruma WASM engine
   cannot run; the JavaScript engine runs VS Code's own grammars with `forgiving: true`.
   Tokenizing a 1 000-line TSX file takes 130–630 ms, so it runs in one module worker
   (`highlight.worker.ts`, allowed by `script-src 'self'`); the page never loads Shiki and
   stays under 50 ms busy while such a file paints (e2e, `data/evidence/code/`). The text
   shows plain at once and in colour when its tokens are ready, with the same lines, so
   nothing moves. Above 5 000 lines or 300 KB the file stays plain, and the header says so.
   Only the token colours come from the theme; the background and font are the app's. The
   regex target depends on the engine, since neither is right on both: JavaScriptCore
   (Safari, Bun) runs the `v` flag of ES2024+ wrong in 1 call of 3–6 at random (`42; // why`
   all as a number; a warm-up line did not cover it), so it gets ES2018. V8 keeps its default:
   on ES2018 a YAML comment with any non-ASCII character takes the string colour. Across 114
   files of 16 languages in the user's repos, that YAML case was V8's only difference.
5. **The grammar from the file, as VS Code picks it.** All of Shiki's ~240 grammars
   (`bundledLanguagesInfo`), each a lazy import, by id and alias (`web/features/code/languages.ts`):
   exact names first (`Dockerfile`, `Makefile`, `.gitmodules`, `tsconfig.*.json` and
   `.vscode/*.json` as JSONC, `.env*`), then the extension, then a shebang (`#!/usr/bin/env
   bun` is TypeScript). An `.html` with `{%` or `{{` is a Django/Jinja template. The header
   shows the grammar's name ("TypeScript", not `typescript`). What no grammar knows (`.txt`,
   `.gitignore`) stays plain: 1–3 % of the files in the user's five repos.
6. **Views besides the code.** Markdown opens as a document (`Prose`, as in Notas), with a
   "Vista | Código" switch; one opened at a line (a diff, a definition) opens on its code.
   Links inside the checkout open in the tile, others in a new tab; its images inside the
   checkout come from `/raw`, outside ones become links (the CSP loads no other site's
   images). An image shows as itself on a checkerboard, with its size; an SVG too, with its
   code a click away. JSON written on one long line gets "Formatear", an indented view that
   never touches the file (in the editor, ADR 0015, it indents the file as an undoable edit). Brackets take VS Code's pair colours by depth (gold, orchid,
   blue), only in code: strings and comments keep theirs.
7. **Go to definition by `git grep`, not a language server.** ⌘/Ctrl+click on a name runs
   POSIX ERE patterns in the repo holding the open file, each from the start of a line (after
   any `export`/`async`/`pub`… modifiers), so a name quoted in a string or a comment is not a
   declaration: by keyword first (`function`, `class`, `type`, `const`, `def`, `fn`,
   `func`…), then methods, arrow properties and Python module assignments. Hits rank as keyword first, then the same file, its folder and the rest. One
   hit jumps there; several or none show a list in the tile, never a silent wrong jump. ⌃-
   goes back (⌥← until ADR 0015: in an editor it moves a word). `ponytail: grep heuristic, not a language server; upgrade to tsserver for TS
   if misses are reported`.
8. **Quick open (⌘P) inside the tile**, over `/files`, with its own subsequence ranking that
   draws the best 50 (cmdk would rank and draw every path of a big repo).
9. **The open file follows the disk.** It polls at the git tile's pace, so an agent's edit
   shows without a refresh. The answer carries a weak ETag (`W/"<size>-<mtime ns>"`, from
   `stat` alone) with `Cache-Control: no-cache`, so the browser revalidates and an unchanged
   file costs a 304 and no read. Open folders are read again every 15 s. A file deleted
   under the tile says so over its last text. The last file per checkout stays in browser
   storage (`aos.code.file:<location>`, ADR 0013).
10. **Keyboard.** The tree is a WAI-ARIA tree (flat: `aria-level`, `aria-setsize`,
    `aria-posinset`) with one Tab stop; arrows or j/k move, →/l opens and enters, ←/h closes
    and goes up, Home/End. The code and the document are focusable regions, so the keyboard
    scrolls them.

## Rejected

| Option | Why not |
|---|---|
| Monaco / CodeMirror | An editor's weight for a reader; the app never wrote code. Monaco since ADR 0015, when it began to |
| Shiki's WASM engine | Needs `wasm-unsafe-eval` in the CSP |
| highlight.js / Prism | Not VS Code's grammars, so not VS Code's colours |
| A language server (tsserver, pyright) | A process per language and repo; grep covers the usual cases |
| ripgrep / ctags | Not on the host; git is |

## Consequences

- A name declared in many places lists them all, and a declaration written in an unusual
  form is missed.
- `/api/code` is server code: 4317 serves a change to it (`/raw`, the ETag) only after a server
  restart; the PTY host does not import it.
