# ADR 0015 — Code editing

Status: accepted (2026-10-09). Scope: the code tile's editor and `PUT /api/code/file`.
Extends [ADR 0014](0014-code-view.md), which was read only.

## Context

The user reviews code in the Mesa's code tile and wants to fix what they see there, without
leaving for an editor: always editable, saved without a button, nothing complicated. Agents
write the same files at the same time, so a save must never silently undo an agent's edit.

## Decision

1. **Monaco, VS Code's own editor, on a desktop pointer.** Undo, find and replace, multiple
   cursors, ⌘/ comments, bracket matching and pair colours come with it. Only its core
   (`monaco-editor/editor/editor.api`) and the features the tile uses
   (`monaco-editor/features/<name>/register`) load, in a lazy chunk (~840 KB gzip): no
   language services and no Monarch grammars (`web/features/code/monaco.ts`). On a touch
   screen (`pointer: coarse`) the tile keeps ADR 0014's read-only viewer: Monaco does not
   support touch.
2. **The viewer's colours, exactly.** A small adapter of our own feeds Monaco the same Shiki
   highlighter and grammars as the viewer, a line at a time, as Monaco asks: each token is
   named by its colour index and style (`c5.f1`, plus `.comment`/`.string`/`.regex`, which
   Monaco reads to leave brackets and quotes inside them alone), and the theme has one rule
   per colour. A grammar loads the first time a file needs it; its brackets, comments and
   indent rules come from Monaco's configuration for the same language (never its `register`,
   which would install a Monarch grammar over ours). A line state compares by its grammar
   stack, so a key re-reads only the lines whose state changed. Measured on the isolated e2e
   (`data/evidence/code/code-editor-spike.json`): 0 CSP violations; opening a 1 068-line TSX
   file with its grammar cold keeps the main thread busy 67 ms at most, jumping to its end
   23 ms; 50 keys painted in 19 ms at most; 1 250 characters of TypeScript, Python, YAML (a
   non-ASCII comment) and a Django template painted as the viewer paints them, brackets aside.
3. **Autosave** (`web/features/code/autosave.ts`): 800 ms after the last key, on leaving the
   editor, on opening another file and on ⌘S. One save at a time; keys typed meanwhile go in
   the next. The header says «Sin guardar», «Guardando…», «Guardado», «Cambiado en disco» or
   «No se ha guardado» (with the reason on hover).
4. **A save lands only on the version the editor opened.** `PUT /api/code/file` takes
   `{ location, path, text, base }`, `base` being the file's ETag (ADR 0014); another version
   on disk is a 409 `stale`. `server/features/code/write.ts` serializes writes per file, writes
   a temporary file in the same folder with the original's permissions (a script stays
   executable) and renames it over, so a reader sees the old text or the new, never half. The
   answer's version is the temporary file's own, taken before the rename, so a write right
   after ours is never mistaken for ours. Refused: inside `.git` and out of the checkout
   (403), a missing file (404: the tile does not create files), binary, not UTF-8 or over
   1 MB (409 `not_editable`), a text over 1 MB (413). Classified `remote`, like git's writes;
   it passes `local-guard` like every write.
5. **The disk keeps moving.** The 5-second poll goes on. A new version with nothing unsaved
   comes in as one undoable edit of just the lines that changed, so the cursor stays. A new
   version under unsaved text, or a 409, stops autosave and shows «Este fichero ha cambiado en
   disco» with «Usar la versión del disco» and «Guardar la mía encima»; the second saves over
   the version on disk now, still checked against it. A poll already on its way when a save
   lands is cancelled, so it cannot bring the old text back as if an agent had written it.
6. **Unsaved text survives closing the file.** Text that could not be saved when the editor
   closed stays in memory as a draft (`web/features/code/editor.tsx`, ADR 0013) and comes back
   when the file opens again, which tries to save it; a page reload with a draft or unsaved
   text asks first.
7. **Read only where saving would be wrong**: text that is not valid UTF-8 (saving would
   change bytes nobody touched) and anything in `.git` open with Monaco's read-only message.
8. **Keys.** Back is ⌃- (VS Code's), since ⌥← moves a word in an editor. ⌘K stays the app's
   palette, so Monaco's ⌘K chords do not run. ⌘V pastes text into the editor: the app's image
   paste leaves `.monaco-editor` alone. «Formatear» on a one-line JSON indents the file as one
   undoable edit that saves.

## Rejected

| Option | Why not |
|---|---|
| CodeMirror 6 | Lezer grammars cover ~25 languages, so colours differ from the viewer's; the Shiki bridge recolours from line 1 on every key |
| A textarea over the viewer | Ours to write: undo, Tab, indentation, find; no multiple cursors |
| `@shikijs/monaco` | Wires every grammar once at start; its line state compares by identity, so every key re-read the rest of the file |
| `modern-monaco` | Loads from a CDN, which the CSP forbids, and is young |
| Monaco on touch screens | Unsupported by Monaco |
| An edit mode and a read mode | The user asked for always editable |

## Consequences

- A stray key on an open file saves. ⌘Z undoes it, and git shows it.
- The editor's chunk is the heaviest in the app; it loads only when a code tile opens a file
  on a desktop, and the browser keeps it.
- Grammars run on the page in the editor (a line at a time, 30 ms cap per line, lines over
  20 000 characters plain) and in the worker in the viewer.
- Monaco keeps one end-of-line kind per file: a file mixing CRLF and LF is saved with one.
- `PUT /api/code/file` is server code: 4317 serves it after a server restart.
