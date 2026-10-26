import { useState } from "react";
import { z } from "zod";
import { mutate } from "../../api.ts";
import { minSec } from "../../format.ts";
import { Icon } from "../../icons.tsx";
import { storageFamily } from "../../storage.ts";
import { createStore, useStore } from "../../store.ts";
import { errorText } from "../../ui.tsx";
import { createPendingStore } from "../voice/pending.ts";
import { type Dictation, transcribe, voiceErrorText } from "../voice/use-dictation.ts";
import { keepFocus } from "./mobile.tsx";

// What the phone's composer holds per terminal, kept across reloads. Its own key: the agent's
// coordination draft (`aos.message.draft:`) is another text, sent another way. The store only
// tells the open composer that a draft changed (a dictation landing while it shows).
const saved = storageFamily("aos.terminal.draft:", { schema: z.string(), fallback: "" });
const changed = createStore(0);

export const draftOf = (id: string) => saved.get(id);
export function setDraft(id: string, text: string) {
  const kept = text ? saved.set(id, text) : saved.remove(id);
  changed.update((n) => n + 1);
  return kept;
}
// A dictation goes after what is already written, one space between them.
export const appendDraft = (id: string, text: string) => {
  const before = draftOf(id);
  return setDraft(id, before && !/\s$/.test(before) ? `${before} ${text}` : `${before}${text}`);
};
export function useDraft(id: string) {
  useStore(changed);
  return draftOf(id);
}

// Phone dictations: the text lands in the draft, for the user to read and send, never straight
// in the terminal. Like the terminal's, it outlives the view that dictated.
export const draftTranscriptions = createPendingStore({
  transcribe,
  send: async (terminal, text) => {
    if (!appendDraft(terminal, text)) throw new Error("el navegador no puede conservar el texto");
  },
  message: voiceErrorText,
});

// The phone's way to answer: a box that grows to four lines and Enviar, which pastes the text
// and presses Enter, as the desktop bar does. Enviar with nothing written is a bare Enter, which
// confirms what the program asks. The phone keyboard's Enter writes a new line.
export function Composer({
  id,
  enabled,
  dictation,
  voice,
}: {
  id: string;
  enabled: boolean;
  dictation: Dictation;
  // Whether dictation is set up on the server; undefined while not known.
  voice: boolean | undefined;
}) {
  const draft = useDraft(id);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  function edit(text: string) {
    if (!setDraft(id, text)) setNotice("El navegador no puede conservar el borrador.");
  }
  async function submit() {
    if (pending || !enabled) return;
    setPending(true);
    setNotice("");
    try {
      await mutate(
        `/api/terminals/${encodeURIComponent(id)}/send`,
        "POST",
        draft ? { text: draft, enter: true } : { enter: true },
      );
      edit("");
    } catch (error) {
      setNotice(`No se ha enviado: ${errorText(error)}.`);
    } finally {
      setPending(false);
    }
  }
  const { phase } = dictation;
  return (
    <form
      className="space-y-1 px-2 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-end gap-1.5">
        <textarea
          aria-label="Escribir en la terminal"
          rows={1}
          value={draft}
          onChange={(e) => edit(e.target.value)}
          autoCapitalize="sentences"
          className="field-sizing-content max-h-[7.5rem] min-h-11 min-w-0 flex-1 resize-none rounded-lg border border-white/20 bg-term-bar px-3 py-2 text-base leading-6"
          placeholder="Escribe…"
        />
        {phase === "recording" ? (
          <button
            type="button"
            className="btn min-h-11 shrink-0 gap-1.5 bg-bad/20 text-bad"
            aria-label="Parar el dictado"
            onPointerDown={keepFocus}
            onClick={() => void dictation.stop()}
          >
            <Icon name="mic" size={16} />
            <span className="font-mono tabular-nums">{minSec(dictation.seconds)}</span>
          </button>
        ) : phase === "transcribing" ? (
          <button
            type="button"
            className="btn min-h-11 shrink-0"
            aria-label="Descartar el dictado"
            onClick={dictation.cancel}
          >
            Transcribiendo…
          </button>
        ) : (
          voice !== false && (
            <button
              type="button"
              className="btn min-h-11 min-w-11 shrink-0"
              aria-label="Dictar"
              disabled={!enabled || !voice}
              onPointerDown={keepFocus}
              onClick={dictation.start}
            >
              <Icon name="mic" size={16} />
            </button>
          )
        )}
        <button
          type="submit"
          disabled={!enabled || pending}
          className="btn min-h-11 shrink-0 bg-term-accent font-medium text-white"
          onPointerDown={keepFocus}
        >
          Enviar
        </button>
      </div>
      {phase === "recording" && (
        <button type="button" className="text-[12px] text-white/60" onClick={dictation.cancel}>
          Descartar la grabación
        </button>
      )}
      {notice && (
        <p role="status" className="text-[12px]">
          {notice}
        </p>
      )}
    </form>
  );
}
