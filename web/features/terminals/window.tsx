import "@xterm/xterm/css/xterm.css";
import "./scrollbar.css";
import { useQueryClient } from "@tanstack/react-query";
import type { Terminal } from "@xterm/xterm";
import { type DragEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useAccess } from "../../access.ts";
import { Icon } from "../../icons.tsx";
import { errorText } from "../../ui.tsx";
import { DictationButton, DictationOverlay } from "../voice/dictation-button.tsx";
import { useDictation, useVoice } from "../voice/use-dictation.ts";
import { useNeedsYou } from "./attention.tsx";
import {
  BRING_MIME,
  bringBlocked,
  bringErrorText,
  bringTo,
  carriesFiles,
  decodeBring,
  imagesIn,
  reportTarget,
} from "./bring.ts";
import { draftTranscriptions } from "./composer.tsx";
import { publishDrafts } from "./draft-strip.tsx";
import { CLOSED, ImagePicker, PasteStatus, type Picker, useImagePaste } from "./images.tsx";
import {
  savedFontSize,
  savedTouchView,
  saveFontSize,
  saveTouchView,
  TouchDock,
  usePhone,
  useTouchLayout,
} from "./mobile.tsx";
import {
  phaseOf,
  rowText,
  shortPath,
  TERM_ICON,
  TerminalMarks,
  terminalHover,
  terminalState,
  WaitPill,
  waitKindOf,
} from "./panel.tsx";
import { PhoneDock, PhoneMenu, terminalMenu } from "./phone-chrome.tsx";
import {
  kindLabel,
  type TerminalInfo,
  terminalLabel,
  useOpenFolder,
  useRenameTerminal,
  useResumeTerminal,
  useTerminalAction,
  useTerminals,
} from "./queries.ts";
import { ConversationReader, canRead } from "./reader.tsx";
import { useTerminal } from "./terminal-socket.ts";
import { actionError, bannerFor, EnvNext, exitText, MoreMenu, NameField } from "./window-parts.tsx";

// The header's fill: its harness's colour (`--h`, from the Mesa tile's `data-harness`), and the
// phase's while it waits for the user, which wins. Both static, so a waiting tile costs no frame
// after it is painted. oklab, not oklch: a hue mixed toward the near-grey header stays itself.
const headerFill = (phase: string, needsYou: boolean) =>
  needsYou
    ? `color-mix(in oklab, ${phase} 40%, var(--term-header))`
    : "color-mix(in oklab, var(--h, var(--term-header)) 24%, var(--term-header))";

// One terminal, live: the popped-out window and the embedded views use it. Only one view
// holds a terminal at a time. `take` lets the first attach displace the view holding it (an
// explicit open); otherwise, and on every automatic retry, the host keeps that view and this
// one offers "Traer aquí". A view never takes a terminal back on its own.
// `onOpen` shows a terminal this view started (the next step after an env create) in its place.
// `lead` goes before the name (the Mesa's tile number), `actions` after the header's own icons
// (the Mesa tile's objective, Mover and Ventana aparte) and `pinned` last, never folded into
// «⋯» (the tile's Ampliar and Quitar); `overlay` sits
// over the screen without resizing it (the tile's replies to a finished turn). A new
// `focusSeq` puts the keys here.
// `drag` makes the header the handle that moves the view (the Mesa's tiles), except while
// renaming, so the name field keeps its text selection.
type HeaderDrag = { onDragStart: (e: DragEvent<HTMLElement>) => void; onDragEnd: () => void };
type ViewProps = {
  id: string;
  take?: boolean;
  autoFocus?: boolean;
  actions?: ReactNode;
  pinned?: ReactNode;
  lead?: ReactNode;
  overlay?: ReactNode;
  focusSeq?: number;
  drag?: HeaderDrag;
  // Whether the phone's dock offers this terminal on a page of its own («Pantalla completa»).
  expand?: boolean;
  onOpen: (terminal: TerminalInfo) => void;
};

// Keyed by id: a view switched to another terminal starts over, so a "Traer aquí" given to
// the previous one never carries to the next.
export const TerminalView = (props: ViewProps) => <View key={props.id} {...props} />;

function View({
  id,
  take = false,
  autoFocus = true,
  actions,
  pinned,
  lead,
  overlay,
  focusSeq,
  drag,
  expand = true,
  onOpen,
}: ViewProps) {
  const desktop = useAccess().data?.desktop;
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [font, setFont] = useState(savedFontSize);
  // Read once per connection, when the terminal is made; later changes go through `refit`.
  const fontRef = useRef(font);
  fontRef.current = font;
  const list = useTerminals().data;
  const info = list?.terminals.find((t) => t.id === id);
  // Read by the touch handling, set up once per connection.
  const harness = useRef(info?.harness);
  harness.current = info?.harness;
  const action = useTerminalAction();
  const rename = useRenameTerminal();
  const resume = useResumeTerminal();
  const openFolder = useOpenFolder();
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [picker, setPicker] = useState<Picker>(CLOSED);
  const images = useImagePaste(id, setNotice);
  // Read by the terminal's paste handler, which is set up once per connection.
  const pasteImages = useRef(images.paste);
  pasteImages.current = images.paste;
  const captureImage = useRef(images.capture);
  captureImage.current = images.capture;
  const client = useQueryClient();
  const voice = useVoice().data;
  const phone = usePhone();
  // Dictated text goes in as a paste, as Cmd+V would put it: never followed by Enter. The
  // server pastes it, so it lands even when this view was left before the text came back. On a
  // phone it goes to the composer instead, to be read before it is sent.
  const dictation = useDictation(
    id,
    () => !phone && termRef.current?.focus(),
    (message) => setNotice(`No se ha transcrito: ${message}.`),
    phone ? draftTranscriptions : undefined,
  );
  // Read by the terminal's key handler, which is set up once per connection.
  const dictate = useRef(dictation);
  dictate.current = dictation;
  const canDictate = useRef(false);
  const { sendInput, refit, status, exit, reattach, drafts } = useTerminal(id, {
    take,
    autoFocus,
    host,
    termRef,
    font: fontRef,
    harness,
    dictate,
    canDictate,
    setPicker,
    pasteImages,
    captureImage,
    onNotice: setNotice,
  });
  // The draft's images show on the shelf beside the terminals, never over this screen.
  useEffect(() => publishDrafts(id, drafts), [id, drafts]);
  useEffect(() => () => publishDrafts(id, []), [id]);

  // The list is not polled: a window that loaded it while the server was away reads it
  // again once its terminal is live.
  useEffect(() => {
    if (status.kind === "live" && !info) void client.invalidateQueries({ queryKey: ["terminals"] });
  }, [status.kind, info, client]);

  useEffect(() => {
    if (focusSeq) termRef.current?.focus();
  }, [focusSeq]);

  // The terminal focused last is where ⌃⌘4 types its capture, from any app on the Mac.
  const target = info && `${terminalLabel(info)} · ${shortPath(info.cwd)}`;
  useEffect(() => {
    const el = host.current;
    if (!el || !target) return;
    const focused = () => reportTarget(id, target);
    if (el.contains(document.activeElement)) focused();
    el.addEventListener("focusin", focused);
    return () => el.removeEventListener("focusin", focused);
  }, [id, target]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `refit` is a ref from useTerminal; only the size changes.
  useEffect(() => {
    const term = termRef.current;
    if (!term || term.options.fontSize === font) return;
    term.options.fontSize = font;
    refit.current();
  }, [font]);

  const running = info?.state === "running" && !exit;
  const live = running && status.kind === "live";
  const touch = useTouchLayout();
  const [touchView, setTouchView] = useState(savedTouchView);
  // The phone's composer sends a coordination message instead of typing.
  const [message, setMessage] = useState(false);
  const agent = Boolean(info && ["claude", "codex", "grok"].includes(info.harness));
  const readable = touch && canRead(info);
  const reading = readable && touchView === "read";
  const needsYou = useNeedsYou(id);
  const state = info ? terminalState(info, needsYou) : "";
  // «Reiniciar» cuts a turn in progress: the same signal as the header's «trabajando».
  const working = info ? phaseOf(info).key === "working" : false;
  const restarting = action.isPending && action.variables?.action === "restart";
  // Same terminal, same id: the window attaches to the new process once the host answers.
  const restart = () => {
    setNotice(null);
    action.mutate(
      { id, action: "restart" },
      {
        onSuccess: () => reattach(false),
        onError: (err) => setNotice(`No se ha reiniciado: ${actionError(err)}`),
      },
    );
  };
  // The microphone is the browser's, so a remote device dictates too; the Mac only transcribes.
  const dictable = Boolean(live && !bringBlocked(info));
  canDictate.current = dictable && Boolean(voice?.configured);
  const changeView = (view: typeof touchView) => {
    setTouchView(view);
    saveTouchView(view);
  };
  const changeFont = (size: number) => {
    setFont(size);
    saveFontSize(size);
  };
  // Reading on a phone never needs the terminal here, so it never offers to take it.
  const banner = bannerFor(status, phone && reading);

  // A ticket, a PR or images of the history dropped here, or image files from the system (they
  // are pasted as Cmd+V pastes them); in the Mesa the tile takes the app's own drops first.
  // Drops on the image picker are not drops on this terminal, though React bubbles them out of
  // its portal.
  const ownDrop = (e: DragEvent<HTMLElement>) =>
    (e.dataTransfer.types.includes(BRING_MIME) || carriesFiles(e.dataTransfer)) &&
    e.currentTarget.contains(e.target as Node) &&
    !bringBlocked(info);
  // Every action in sight, as an icon. On a touch screen that is not a phone, or in a header
  // under 26rem, the secondary ones go into «⋯» (at a size a finger can hit); a phone's has its
  // own menu, in words (PhoneMenu).
  const secondary = (
    <>
      {info && !editing && (
        <button
          type="button"
          className={TERM_ICON}
          aria-label="Renombrar"
          title="Renombrar"
          onClick={() => setEditing(true)}
        >
          <Icon name="pencil" size={14} />
        </button>
      )}
      {agent && info && (
        <a
          className={TERM_ICON}
          href={`/agentes?s=mensajes&a=${encodeURIComponent(info.id)}`}
          target="_blank"
          rel="noreferrer"
          aria-label="Mensajes y reservas del arnés"
          title="Mensajes y reservas del arnés"
        >
          <Icon name="agents" size={14} />
        </a>
      )}
      {info && desktop && (
        <button
          type="button"
          className={`${TERM_ICON} disabled:opacity-40 disabled:hover:bg-transparent`}
          aria-label="Abrir carpeta"
          title={
            list?.openFolder
              ? `Abrir ${info.cwd} en el editor`
              : "Abrir carpeta: añade terminals.editor en config.json"
          }
          disabled={!list?.openFolder || openFolder.isPending}
          onClick={() => {
            setNotice(null);
            openFolder.mutate(id, { onError: (err) => setNotice(actionError(err)) });
          }}
        >
          <Icon name="folder" size={14} />
        </button>
      )}
      {actions}
    </>
  );
  // «Reiniciar» asks first only when it would cut a turn in progress.
  const confirmRestart = () =>
    (!working || window.confirm("¿Cortar el turno y reiniciar?")) && restart();
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target only; the picker's Pegar button does the same from the keyboard
    <div
      className="@container flex h-full min-h-0 flex-col bg-term-bg text-term-ink"
      onDragOver={(e) => {
        if (!ownDrop(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => {
        if (!ownDrop(e)) return;
        e.preventDefault();
        if (carriesFiles(e.dataTransfer)) {
          const { images: files, others } = imagesIn(e.dataTransfer);
          images.paste(files, others);
          termRef.current?.focus();
          return;
        }
        const item = decodeBring(e.dataTransfer.getData(BRING_MIME));
        if (!item) return;
        setNotice(null);
        bringTo(id, item)
          .then(() => termRef.current?.focus())
          .catch((err) => setNotice(`No se ha llevado a la terminal: ${bringErrorText(err)}.`));
      }}
    >
      {/* The state and the harness as two marks, then what the terminal is about (the rail's
          text: its name, else the agent's session title or last prompt), which takes the room.
          A narrow tile drops the cwd first, then the room between the buttons (asked of the
          view: a container cannot query itself); the text and an exit text truncate, and every
          action stays. The state's words live in the marks' title and for screen readers. */}
      <header
        className={`@container flex h-9 shrink-0 items-center gap-1.5 @max-[20rem]:gap-0.5 border-b border-white/10 bg-term-header px-2 text-[12px] pointer-coarse:h-11 pointer-coarse:[&>a]:size-10 pointer-coarse:[&>button]:size-10 ${
          drag && !editing ? "cursor-grab active:cursor-grabbing" : ""
        }`}
        style={
          info
            ? {
                background: headerFill(phaseOf(info).color, needsYou),
              }
            : undefined
        }
        {...(drag && !editing && { draggable: true, ...drag })}
      >
        {lead}
        {info && <TerminalMarks t={info} needsYou={needsYou} state={state} />}
        {info && editing ? (
          <NameField
            initial={info.name ?? ""}
            onDone={(name) => {
              setEditing(false);
              if (name === undefined || name.trim() === (info.name ?? "")) return;
              setNotice(null);
              rename.mutate({ id, name }, { onError: (err) => setNotice(actionError(err)) });
            }}
          />
        ) : info ? (
          <span
            data-part="title"
            className="min-w-0 truncate font-medium text-white/90"
            title={terminalHover(info, state)}
          >
            {rowText(info)}
          </span>
        ) : (
          <span className="whitespace-nowrap font-semibold">Terminal</span>
        )}
        {info && needsYou && <WaitPill kind={waitKindOf(info)} />}
        {/* The state's words only once connected, as before: until then the header says
            "conectando…", and tests wait on these words to know the terminal is live. */}
        {info && (
          <span className="sr-only">{live ? `${kindLabel(info)}, ${state}` : kindLabel(info)}</span>
        )}
        {info?.ticket && (
          <span className="shrink-0 rounded border border-white/15 px-1.5 font-mono text-white/80">
            {info.ticket}
          </span>
        )}
        {/* Takes the room left, so the buttons stay right; the cwd shows only on a wide tile. */}
        <span className="min-w-0 flex-1 truncate font-mono text-white/55" title={info?.cwd}>
          <span className="hidden @[26rem]:inline">{info && shortPath(info.cwd)}</span>
        </span>
        {(restarting || status.kind === "connecting" || status.kind === "reconnecting" || exit) && (
          <span
            className="ml-auto min-w-0 max-w-[60%] truncate text-white/60"
            title={exit ? exitText(exit) : undefined}
          >
            {restarting
              ? "reiniciando…"
              : status.kind === "connecting"
                ? "conectando…"
                : status.kind === "reconnecting"
                  ? "reconectando…"
                  : exit && exitText(exit)}
          </span>
        )}
        {dictable && !phone && (
          <DictationButton dictation={dictation} configured={Boolean(voice?.configured)} />
        )}
        {info && (
          <ImagePicker
            id={id}
            blocked={bringBlocked(info)}
            picker={picker}
            onChange={setPicker}
            onClosed={() => termRef.current?.focus()}
            onCapture={images.capture}
          />
        )}
        {running && agent && !phone && (
          <button
            type="button"
            className={TERM_ICON}
            aria-label="Reiniciar"
            title={working ? "Cortar el turno y reiniciar" : "Reiniciar"}
            disabled={restarting}
            onClick={confirmRestart}
          >
            <Icon name="refresh" size={14} />
          </button>
        )}
        {running && !phone && (
          <button
            type="button"
            className={`${TERM_ICON} hover:text-bad`}
            aria-label="Parar"
            title="Parar"
            onClick={() => action.mutate({ id, action: "stop" })}
          >
            <Icon name="stop" size={14} />
          </button>
        )}
        {phone ? (
          <PhoneMenu
            font={font}
            onFont={changeFont}
            actions={
              <>
                {actions}
                {pinned}
              </>
            }
            items={terminalMenu({
              id,
              reading: readable ? reading : null,
              onView: changeView,
              onMessage: agent && !message && (() => setMessage(true)),
              agent,
              onRename: Boolean(info) && (() => setEditing(true)),
              onRestart: running && agent && confirmRestart,
              onStop: running && (() => action.mutate({ id, action: "stop" })),
            })}
          />
        ) : touch ? (
          <MoreMenu>{secondary}</MoreMenu>
        ) : (
          // In sight, close together, from a 26rem header: a narrower one (three tiles abreast,
          // or two beside the rail on a small screen) has no room for them and the name.
          <>
            <span className="hidden shrink-0 items-center gap-0.5 @[26rem]:flex">{secondary}</span>
            <span className="contents @[26rem]:hidden">
              <MoreMenu>{secondary}</MoreMenu>
            </span>
          </>
        )}
        {!phone && pinned}
      </header>
      {notice && (
        <div role="alert" className="flex items-center gap-3 bg-term-error px-3 py-1.5 text-[12px]">
          <span className="min-w-0 flex-1">{notice}</span>
          <button
            type="button"
            className={TERM_ICON}
            aria-label="Cerrar aviso"
            onClick={() => setNotice(null)}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      )}
      {banner && (
        <div role="alert" className="flex items-center gap-3 bg-term-you px-3 py-2 text-[12px]">
          <span>{banner.text}</span>
          {banner.action && (
            <button
              type="button"
              className="rounded bg-term-accent px-2 py-0.5 font-medium text-white disabled:opacity-60"
              disabled={resume.isPending}
              onClick={() => {
                const reconnect = () => reattach(banner.take);
                if (status.kind !== "lost") return reconnect();
                setNotice(null);
                resume.mutate(id, {
                  onSuccess: reconnect,
                  onError: (err) => setNotice(`No se ha reanudado: ${errorText(err)}.`),
                });
              }}
            >
              {banner.action}
            </button>
          )}
        </div>
      )}
      {/* Only a create has a new env to launch in; other commands end with nothing to offer. */}
      {info?.harness === "env" && info.action === "create" && (
        <EnvNext info={info} exit={exit} onOpen={onOpen} />
      )}
      {/* The margin sits here, not on the screen: the fit takes the screen's whole box for rows,
          padding included, and the last row would fall under the bottom edge. */}
      <div className="relative flex min-h-0 flex-1 flex-col p-1">
        <div ref={host} data-terminal-screen className="min-h-0 flex-1 overflow-hidden" />
        {!reading && overlay}
        <DictationOverlay dictation={dictation} />
        <PasteStatus
          pasting={images.pasting}
          onHistory={(marks) => setPicker({ open: true, marks, uploading: false })}
        />
        {/* Over the screen, not instead of it: the terminal keeps its size underneath. */}
        {reading && info && (
          <ConversationReader
            info={info}
            font={font}
            status={!phone}
            onTerminal={() => setTouchView("terminal")}
          />
        )}
      </div>
      {phone ? (
        <PhoneDock
          id={id}
          enabled={running}
          live={live}
          send={(data) => sendInput.current(data)}
          keysShown={!reading}
          asks={Boolean(info?.agent?.asks)}
          message={agent && message}
          onType={() => setMessage(false)}
          dictation={dictation}
          voice={voice?.configured}
        />
      ) : (
        <TouchDock
          id={id}
          agent={agent}
          enabled={running}
          live={live}
          send={(data) => sendInput.current(data)}
          view={readable ? touchView : undefined}
          expand={expand ? `/terminal/${encodeURIComponent(id)}` : undefined}
          onView={changeView}
          font={font}
          onFont={changeFont}
        />
      )}
    </div>
  );
}
