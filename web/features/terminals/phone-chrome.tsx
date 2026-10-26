import { type ReactNode, useState } from "react";
import type { TerminalKey } from "../../../shared/terminals.ts";
import type { Dictation } from "../voice/use-dictation.ts";
import { AskCard } from "./ask-card.tsx";
import { Composer } from "./composer.tsx";
import { AgentComposer, FONT, keepFocus, useKeyPress } from "./mobile.tsx";
import { TERM_ICON } from "./panel.tsx";

// What a phone shows of a terminal: a slim header whose «⋯» holds every other action in words,
// the conversation or the screen, a card while the agent asks, and the composer. Keys show only
// for the screen, and leave while the keyboard is up.

const PHONE_KEYS: [string, TerminalKey][] = [
  ["Esc", "esc"],
  ["⇧Tab", "shift-tab"],
  ["↑", "up"],
  ["↓", "down"],
  ["Enter", "enter"],
  ["Ctrl+C", "ctrl-c"],
];

export type MenuItem = { label: string; onSelect?: () => void; href?: string; danger?: boolean };
const ROW =
  "flex min-h-11 w-full items-center rounded-md px-3 text-left text-[14px] hover:bg-white/10";

// The terminal's actions on a phone; a false one is not offered.
export function terminalMenu(o: {
  id: string;
  // null for a terminal with no conversation to read.
  reading: boolean | null;
  onView: (view: "read" | "terminal") => void;
  agent: boolean;
  onMessage: false | (() => void);
  onRename: false | (() => void);
  onRestart: false | (() => void);
  onStop: false | (() => void);
}): (MenuItem | false)[] {
  return [
    o.reading !== null && {
      label: o.reading ? "Ver terminal" : "Leer",
      onSelect: () => o.onView(o.reading ? "terminal" : "read"),
    },
    o.onMessage && { label: "Mensaje al agente", onSelect: o.onMessage },
    o.onRename && { label: "Renombrar", onSelect: o.onRename },
    o.agent && {
      label: "Mensajes y reservas",
      href: `/agentes?s=mensajes&a=${encodeURIComponent(o.id)}`,
    },
    o.onRestart && { label: "Reiniciar", onSelect: o.onRestart },
    o.onStop && { label: "Parar", danger: true, onSelect: o.onStop },
  ];
}

// A menu of labelled rows a finger can hit; choosing one closes it. `actions` are the view's
// own icon buttons (a Mesa tile's), in a row at the end.
export function PhoneMenu({
  items,
  font,
  onFont,
  actions,
}: {
  items: (MenuItem | false | undefined)[];
  font: number;
  onFont: (size: number) => void;
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        className={`${TERM_ICON} size-10 text-[18px]`}
        aria-label="Más acciones"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        ⋯
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label="Cerrar el menú"
            className="fixed inset-0 z-30 cursor-default bg-black/30"
            onClick={close}
          />
          <div
            role="menu"
            className="absolute top-full right-0 z-40 mt-1 flex w-64 max-w-[calc(100vw-1rem)] flex-col gap-0.5 rounded-lg border border-white/15 bg-term-bar p-1 shadow-lg"
          >
            {items.map(
              (item) =>
                item &&
                (item.href ? (
                  <a
                    key={item.label}
                    role="menuitem"
                    className={ROW}
                    href={item.href}
                    target="_blank"
                    rel="noreferrer"
                    onClick={close}
                  >
                    {item.label}
                  </a>
                ) : (
                  <button
                    key={item.label}
                    type="button"
                    role="menuitem"
                    className={`${ROW} ${item.danger ? "text-bad" : ""}`}
                    onClick={() => {
                      close();
                      item.onSelect?.();
                    }}
                  >
                    {item.label}
                  </button>
                )),
            )}
            <div className="flex min-h-11 items-center gap-1 px-3 text-[14px]">
              <span className="flex-1">Letra</span>
              <button
                type="button"
                className="btn min-h-10 min-w-10"
                aria-label="Letra más pequeña"
                disabled={font <= FONT.min}
                onClick={() => onFont(font - 1)}
              >
                A−
              </button>
              <button
                type="button"
                className="btn min-h-10 min-w-10"
                aria-label="Letra más grande"
                disabled={font >= FONT.max}
                onClick={() => onFont(font + 1)}
              >
                A+
              </button>
            </div>
            {actions && (
              <div className="flex gap-1 border-t border-white/10 px-2 pt-1 *:size-11">
                {actions}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function PhoneDock({
  id,
  enabled,
  live,
  send,
  keysShown,
  asks,
  message,
  onType,
  dictation,
  voice,
}: {
  id: string;
  enabled: boolean;
  live: boolean;
  send: (data: string) => void;
  // The screen shows, not the conversation.
  keysShown: boolean;
  asks: boolean;
  // A coordination message to the agent instead of typing («Mensaje al agente» in «⋯»).
  message: boolean;
  onType: () => void;
  dictation: Dictation;
  voice: boolean | undefined;
}) {
  const { press, keyNotice } = useKeyPress(id, live, send);
  // The keyboard is up: the keys give their room to the text.
  const [typing, setTyping] = useState(false);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: it only watches where the focus is; the controls inside are the interaction
    <div
      data-touch-dock
      className="shrink-0 border-t border-white/10 bg-term-bg"
      onFocus={(e) => setTyping(e.target.matches("textarea, input"))}
      onBlur={() => setTyping(false)}
    >
      {asks && enabled && <AskCard id={id} press={press} />}
      {keysShown && !typing && (
        <fieldset
          aria-label="Teclas de terminal"
          className="flex min-w-0 gap-1 overflow-x-auto px-2 pt-2"
        >
          {PHONE_KEYS.map(([label, key]) => (
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
        </fieldset>
      )}
      {keyNotice && (
        <p role="status" className="px-2 pt-1 text-[12px]">
          {keyNotice}
        </p>
      )}
      {message ? (
        <AgentComposer
          id={id}
          enabled={enabled}
          extra={
            <button type="button" className="btn min-h-11 shrink-0" onClick={onType}>
              Escribir
            </button>
          }
        />
      ) : (
        <Composer id={id} enabled={enabled} dictation={dictation} voice={voice} />
      )}
    </div>
  );
}
