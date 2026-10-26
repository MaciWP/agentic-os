import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../../api.ts";
import { createStore } from "../../store.ts";
import { Autosave, minimalEdit, type SaveStatus } from "./autosave.ts";
import "./editor.css";
import { langName, langOf } from "./languages.ts";
import { EDITOR_THEME, monaco, prepare } from "./monaco.ts";
import { type CodeFile, saveCodeFile, savedCodeFile } from "./queries.ts";

const HEAD = 1024;

// Unsaved text by file, kept when the editor closes before it could save (a switch to another
// file whose save then fails, a conflict left open): opening the file again brings it back.
// A reload of the page with any of it asks first.
type Draft = { text: string; base: string };
const drafts = createStore<ReadonlyMap<string, Draft>>(new Map());
function keepDraft(key: string, draft: Draft | null) {
  drafts.update((all) => {
    if (!draft && !all.has(key)) return all;
    const next = new Map(all);
    if (draft) next.set(key, draft);
    else next.delete(key);
    return next;
  });
}
if (typeof window !== "undefined")
  window.addEventListener("beforeunload", (e) => {
    if (drafts.get().size > 0) e.preventDefault();
  });

type Text = Extract<CodeFile, { kind: "text" }>;

// What the editor holds while it lives: Monaco, its model and its saves.
type Live = {
  editor: monaco.editor.IStandaloneCodeEditor;
  model: monaco.editor.ITextModel;
  auto: Autosave;
  // Writes the disk's text into the editor as one undoable edit that is not the user's.
  take: (text: string, version: string) => void;
};

// One file in VS Code's editor, on a desktop pointer, always editable and saved by itself
// (autosave.ts): its grammar's colours, the line asked for marked and centred, ⌘/Ctrl+click
// on a name asks where it is defined. When an agent writes the file, its text comes in if
// nothing here is unsaved; otherwise the editor says so and lets the user pick. Loaded
// lazily (file-view.tsx): Monaco is the tile's heaviest part and only this pane needs it.
export default function CodeEditor({
  location,
  path,
  label,
  file,
  line,
  formatAsk,
  format,
  refetch,
  onWord,
  onName,
  onStatus,
}: {
  location: string;
  path: string;
  label: string;
  // The file as the last poll read it.
  file: Text;
  // The line to mark and centre; the tile mounts this anew for each open, so it never moves.
  line: number | null;
  // Each new value asks for `format` over the editor's text, as one undoable edit.
  formatAsk: number;
  format: (text: string) => string | null;
  // The disk's file now, read again.
  refetch: () => Promise<CodeFile | undefined>;
  onWord: (name: string, line: number) => void;
  // The grammar's name for the header, once known.
  onName: (name: string) => void;
  onStatus: (status: SaveStatus, error: unknown) => void;
}) {
  const client = useQueryClient();
  const host = useRef<HTMLElement>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [status, setStatus] = useState<SaveStatus>("saved");
  const latest = useRef({ label, file, onWord, onName, onStatus });
  latest.current = { label, file, onWord, onName, onStatus };

  // The tile mounts this anew for each file it opens, so the editor, its model and its saves
  // live as long as this mount.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const first = latest.current.file;
    const key = `${location}\0${path}`;
    const lang = langOf(path, first.text.slice(0, HEAD));
    latest.current.onName(lang ? langName(lang) : "Texto");
    const mount = { gone: false, live: null as Live | null };
    void prepare(lang).then((id) => {
      if (mount.gone) return;
      const draft = first.editable ? drafts.get().get(key) : undefined;
      const model = monaco.editor.createModel(draft?.text ?? first.text, id);
      const editor = monaco.editor.create(el, {
        model,
        theme: EDITOR_THEME,
        ariaLabel: latest.current.label,
        readOnly: !first.editable,
        readOnlyMessage: { value: "Este fichero no se edita aquí: no es UTF-8 o está en .git." },
        automaticLayout: true,
        minimap: { enabled: false },
        fontFamily: getComputedStyle(el).fontFamily,
        fontSize: 12,
        lineHeight: 20,
        padding: { top: 8, bottom: 8 },
        scrollBeyondLastLine: false,
        bracketPairColorization: { enabled: true },
        fixedOverflowWidgets: true,
      });
      const report = (s: SaveStatus, error: unknown) => {
        if (s === "saved") keepDraft(key, null);
        if (!mount.gone) setStatus(s);
        latest.current.onStatus(s, error);
      };
      const auto = new Autosave(
        {
          // The cache holds the saved file before the editor takes its version: the poll
          // that follows finds nothing new.
          save: async (text, base) => {
            const saved = await saveCodeFile(location, path, text, base);
            await savedCodeFile(client, location, path, { text, ...saved });
            return saved;
          },
          text: () => model.getValue(),
          rev: () => model.getAlternativeVersionId(),
          isStale: (err) => err instanceof ApiError && err.code === "stale",
          onStatus: report,
        },
        draft?.base ?? first.version,
        // A draft brought back is unsaved from the start.
        draft ? -1 : model.getAlternativeVersionId(),
      );
      const own = { applying: false };
      const take = (text: string, version: string) => {
        const now = model.getValue();
        if (now !== text) {
          const edit = minimalEdit(now, text);
          own.applying = true;
          model.pushStackElement();
          model.pushEditOperations(
            [],
            [
              {
                range: monaco.Range.fromPositions(
                  model.getPositionAt(edit.start),
                  model.getPositionAt(edit.end),
                ),
                text: edit.text,
              },
            ],
            () => null,
          );
          model.pushStackElement();
          own.applying = false;
        }
        auto.took(version);
      };
      model.onDidChangeContent(() => {
        if (!own.applying) auto.edited();
      });
      editor.onDidBlurEditorText(() => void auto.flush());
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void auto.flush());
      editor.onMouseDown((e) => {
        const at = e.target.position;
        if (!(e.event.metaKey || e.event.ctrlKey) || !at) return;
        const word = model.getWordAtPosition(at);
        if (word) latest.current.onWord(word.word, at.lineNumber);
      });
      mount.live = { editor, model, auto, take };
      setLive(mount.live);
      if (draft) void auto.flush();
    });
    const unload = (e: BeforeUnloadEvent) => {
      const auto = mount.live?.auto;
      if (auto && (auto.dirty || auto.status === "conflict")) e.preventDefault();
    };
    window.addEventListener("beforeunload", unload);
    return () => {
      mount.gone = true;
      window.removeEventListener("beforeunload", unload);
      const m = mount.live;
      if (!m) return;
      // Leaving the file saves it; what cannot be saved yet waits as a draft.
      if (m.auto.dirty || m.auto.status === "conflict") {
        keepDraft(key, { text: m.model.getValue(), base: m.auto.base });
      }
      // The model outlives the editor until that save settles: Autosave reads its revision then.
      m.editor.dispose();
      void m.auto.flush().finally(() => m.model.dispose());
    };
  }, [client, location, path]);

  // Each poll: an agent's edit comes in when nothing here is unsaved.
  useEffect(() => {
    if (live?.auto.disk(file.version) === "take") live.take(file.text, file.version);
  }, [live, file.version, file.text]);

  // The line a diff or a definition asked for: marked, centred, the cursor on it.
  useEffect(() => {
    if (!live || !line) return;
    const marks = live.editor.createDecorationsCollection([
      {
        range: new monaco.Range(line, 1, line, 1),
        options: { isWholeLine: true, className: "code-line-mark" },
      },
    ]);
    live.editor.setPosition({ lineNumber: line, column: 1 });
    live.editor.revealLineInCenter(line);
    return () => marks.clear();
  }, [live, line]);

  // "Formatear": the formatted text replaces the editor's, undoable with ⌘Z, and saves.
  const formatted = useRef(formatAsk);
  useEffect(() => {
    if (!live || formatAsk === formatted.current) return;
    formatted.current = formatAsk;
    const pretty = format(live.model.getValue());
    if (pretty === null) return;
    live.editor.pushUndoStop();
    live.editor.executeEdits("format", [{ range: live.model.getFullModelRange(), text: pretty }]);
    live.editor.pushUndoStop();
  }, [live, formatAsk, format]);

  const takeDisk = async () => {
    const disk = await refetch().catch(() => undefined);
    if (live && disk?.kind === "text") live.take(disk.text, disk.version);
  };
  const keepMine = async () => {
    const disk = await refetch().catch(() => undefined);
    if (live) void live.auto.overwrite(disk?.version ?? live.auto.base);
  };

  return (
    <>
      {status === "conflict" && (
        <div
          role="alert"
          className="flex shrink-0 flex-wrap items-center gap-2 border-line border-b px-3 py-2 text-[12px]"
        >
          <span className="text-warn">
            Este fichero ha cambiado en disco y aquí hay cambios sin guardar.
          </span>
          <span className="ml-auto flex gap-1">
            <button type="button" className="btn-ghost h-6 px-2" onClick={() => void takeDisk()}>
              Usar la versión del disco
            </button>
            <button type="button" className="btn-ghost h-6 px-2" onClick={() => void keepMine()}>
              Guardar la mía encima
            </button>
          </span>
        </div>
      )}
      <section
        aria-label={label}
        data-code-editor
        className="min-h-0 flex-1 bg-bg font-mono"
        ref={host}
      />
    </>
  );
}
