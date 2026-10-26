import { type PointerEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { MessageRecord } from "../../../shared/coordination.ts";
import { TERMINAL_KEYS, type TerminalKey } from "../../../shared/terminals.ts";
import { ApiError, mutate } from "../../api.ts";
import { storageFamily, storageKey } from "../../storage.ts";
import { errorText } from "../../ui.tsx";
import { STATE } from "../coordination/queries.ts";

function useMedia(query: string) {
  const [matches, set] = useState(
    () => typeof matchMedia !== "undefined" && matchMedia(query).matches,
  );
  useEffect(() => {
    const media = matchMedia(query);
    const update = () => set(media.matches);
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export const useNarrow = () => useMedia("(max-width: 767px)");
// Where the dock shows: a narrow screen or a touch screen (its `pointer-coarse` / `max-md`).
export const useTouchLayout = () => useMedia("(max-width: 767px), (pointer: coarse)");
// A phone or a tablet: touch only. Not a narrow desktop window, which still takes what it opens.
export const PHONE = "(hover: none) and (pointer: coarse)";
export const usePhone = () => useMedia(PHONE);
// The keys a phone keyboard lacks, by the names the server maps to bytes (shared/terminals.ts).
export const KEYS: [string, TerminalKey][] = [
  ["Esc", "esc"],
  ["Tab", "tab"],
  ["⇧Tab", "shift-tab"],
  ["↑", "up"],
  ["↓", "down"],
  ["←", "left"],
  ["→", "right"],
  ["Enter", "enter"],
  ["Ctrl+C", "ctrl-c"],
];

// What the screen shows on a phone for an agent: its conversation as text, or the terminal.
export type TouchView = "read" | "terminal";
const touchView = storageKey("aos.terminal-touch-view", {
  schema: z.enum(["read", "terminal"]),
  fallback: "read",
  legacy: "terminal-touch-view",
});
export const savedTouchView = () => touchView.get();
export const saveTouchView = (view: TouchView) => void touchView.set(view);

// The terminal's letter size on this device: a phone reads a long answer at its own size.
export const FONT = { min: 9, base: 13, max: 20 };
const fontSize = storageKey("aos.terminal-font-size", {
  schema: z.coerce.number().int().min(FONT.min).max(FONT.max),
  fallback: FONT.base,
  legacy: "terminal-font-size",
});
export const savedFontSize = () => fontSize.get();
export const saveFontSize = (size: number) => void fontSize.set(size);

// What the composer keeps per terminal: the draft, and the id of a send not yet confirmed, so
// a retry after a reload is the same request.
const drafts = storageFamily("aos.message.draft:", { schema: z.string(), fallback: "" });
export const sends = storageFamily("aos.message.request:", {
  schema: z.string(),
  fallback: "",
  legacy: (id) => `aos.message.draft:${id}:request`,
});

// A tap on a key or a button leaves the focus in the bar, so the phone's keyboard stays up.
export const keepFocus = (e: PointerEvent) => e.preventDefault();

// A key the phone keyboard lacks: over the socket when this window holds the terminal (`live`),
// else through /send, one after another, so ↓ ↓ Enter arrives in that order.
export function useKeyPress(id: string, live: boolean, send: (data: string) => void) {
  const [keyNotice, setKeyNotice] = useState("");
  const keys = useRef(Promise.resolve());
  function press(key: TerminalKey) {
    if (live) return send(TERMINAL_KEYS[key]);
    setKeyNotice("");
    keys.current = keys.current
      .then(() => mutate(`/api/terminals/${encodeURIComponent(id)}/send`, "POST", { keys: [key] }))
      .then(
        () => {},
        (error) => setKeyNotice(`No se ha enviado la tecla: ${errorText(error)}.`),
      );
  }
  return { press, keyNotice };
}

// Below the terminal on a phone or a touch screen: the keys a phone keyboard lacks, in one row
// that scrolls sideways, and a bar that types straight into the program. An agent can also get
// a coordination message instead («Mensaje»), and one with a transcript is read as text
// («Leer» / «Terminal»). Everything works while the terminal runs, held here or not: the bar
// and the keys go through /send unless this window holds the terminal (`live`).
export function TouchDock({
  id,
  agent,
  enabled,
  live,
  send,
  font,
  onFont,
  view,
  onView,
  expand,
}: {
  id: string;
  agent: boolean;
  enabled: boolean;
  live: boolean;
  send: (data: string) => void;
  font: number;
  onFont: (size: number) => void;
  // Only for a terminal that can be read.
  view?: TouchView;
  onView?: (view: TouchView) => void;
  // The terminal's full-screen page, when this is not it.
  expand?: string;
}) {
  const [mode, setMode] = useState<"type" | "message">("type");
  const { press, keyNotice } = useKeyPress(id, live, send);
  const switchTo = (next: "type" | "message", label: string) => (
    <button type="button" className="btn min-h-11 shrink-0" onClick={() => setMode(next)}>
      {label}
    </button>
  );
  return (
    <div
      data-touch-dock
      className="hidden shrink-0 border-t border-white/10 pointer-coarse:block max-md:block"
    >
      <fieldset
        aria-label="Teclas de terminal"
        className="flex min-w-0 gap-1 overflow-x-auto px-2 py-1"
      >
        {view && onView && (
          <button
            type="button"
            className="btn min-h-11 shrink-0 font-medium"
            onClick={() => onView(view === "read" ? "terminal" : "read")}
          >
            {view === "read" ? "Terminal" : "Leer"}
          </button>
        )}
        {KEYS.map(([label, key]) => (
          <button
            key={label}
            type="button"
            disabled={!enabled}
            className="btn min-h-11 min-w-11 shrink-0"
            onPointerDown={keepFocus}
            onClick={() => press(key)}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          aria-label="Letra más pequeña"
          disabled={font <= FONT.min}
          className="btn min-h-11 min-w-11 shrink-0"
          onPointerDown={keepFocus}
          onClick={() => onFont(font - 1)}
        >
          A−
        </button>
        <button
          type="button"
          aria-label="Letra más grande"
          disabled={font >= FONT.max}
          className="btn min-h-11 min-w-11 shrink-0"
          onPointerDown={keepFocus}
          onClick={() => onFont(font + 1)}
        >
          A+
        </button>
        {expand && (
          <a className="btn min-h-11 shrink-0" href={expand}>
            Pantalla completa
          </a>
        )}
      </fieldset>
      {keyNotice && (
        <p role="status" className="px-2 text-[12px]">
          {keyNotice}
        </p>
      )}
      {mode === "message" && agent ? (
        <AgentComposer id={id} enabled={enabled} extra={switchTo("type", "Escribir")} />
      ) : (
        <TypeBar id={id} enabled={enabled} extra={agent ? switchTo("message", "Mensaje") : null} />
      )}
    </div>
  );
}

// Sent as the dictation is: pasted, then Enter, so a multi-word line reaches the program whole.
// Enviar with nothing written is a bare Enter, which confirms what the program asks.
function TypeBar({ id, enabled, extra }: { id: string; enabled: boolean; extra: ReactNode }) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  async function submit() {
    if (pending || !enabled) return;
    setPending(true);
    setNotice("");
    try {
      await mutate(
        `/api/terminals/${encodeURIComponent(id)}/send`,
        "POST",
        text ? { text, enter: true } : { enter: true },
      );
      setText("");
    } catch (error) {
      setNotice(`No se ha enviado: ${errorText(error)}.`);
    } finally {
      setPending(false);
    }
  }
  return (
    <form
      className="space-y-1 px-2 pb-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex gap-2">
        <input
          aria-label="Escribir en la terminal"
          value={text}
          onChange={(e) => setText(e.target.value)}
          enterKeyHint="send"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          className="min-h-11 min-w-0 flex-1 rounded border border-white/20 bg-term-bar px-2 text-base"
          placeholder="Escribe y pulsa Enviar…"
        />
        <button
          type="submit"
          disabled={!enabled || pending}
          className="btn min-h-11 shrink-0"
          onPointerDown={keepFocus}
        >
          Enviar
        </button>
        {extra}
      </div>
      {notice && (
        <p role="status" className="text-[12px]">
          {notice}
        </p>
      )}
    </form>
  );
}

// Durable request IDs belong to a particular draft. An uncertain delivery cannot be edited
// into a different request; the user must inspect its status before starting another one.
export function AgentComposer({
  id,
  enabled,
  extra,
}: {
  id: string;
  enabled: boolean;
  extra?: ReactNode;
}) {
  const [draft, setDraft] = useState(() => drafts.get(id));
  const [requestId, setRequest] = useState<string | null>(() => sends.get(id) || null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  function edit(text: string) {
    setDraft(text);
    if (!drafts.set(id, text)) setNotice("El navegador no puede conservar el borrador.");
  }
  async function send() {
    if (pending || !enabled || !draft.trim()) return;
    const request = requestId ?? crypto.randomUUID();
    setRequest(request);
    setPending(true);
    setNotice("");
    sends.set(id, request);
    try {
      const message = MessageRecord.parse(
        await mutate("/api/coordination/messages", "POST", {
          requestId: request,
          to: id,
          text: draft,
        }),
      );
      setNotice(
        `Mensaje registrado: ${STATE[message.status] ?? message.status}. Consulta su entrega en Mensajes.`,
      );
      setRequest(null);
      edit("");
      sends.remove(id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) {
        setRequest(null);
        sends.remove(id);
      }
      setNotice(errorText(error));
    } finally {
      setPending(false);
    }
  }
  return (
    <form
      className="space-y-1 px-2 pb-2"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <textarea
        aria-label="Mensaje al agente"
        rows={2}
        value={draft}
        readOnly={!!requestId}
        onChange={(e) => edit(e.target.value)}
        className="w-full rounded border border-white/20 bg-term-bar p-2 text-base"
        placeholder="Escribe al agente…"
      />
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={!enabled || pending || !draft.trim()}
          className="btn min-h-11"
        >
          {requestId ? "Comprobar / reintentar envío" : "Enviar mensaje"}
        </button>
        <a
          className="text-[12px] text-primary"
          href={`/agentes?s=mensajes&a=${encodeURIComponent(id)}`}
        >
          Ver mensajes
        </a>
        {extra}
      </div>
      {notice && (
        <p role="status" className="text-[12px]">
          {notice}
        </p>
      )}
    </form>
  );
}
