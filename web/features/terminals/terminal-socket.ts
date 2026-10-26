import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";
import { z } from "zod";
import { clampSize } from "../../../shared/terminals.ts";
import { ApiError } from "../../api.ts";
import { copyText } from "../../clipboard.ts";
import { retryDelay } from "../../events.ts";
import { isCaptureKey, isMacClient, isNextKey } from "../../keys.ts";
import { machineUrl } from "../../machine.ts";
import { errorText } from "../../ui.tsx";
import { DictationKeys } from "../voice/hotkey.ts";
import type { Dictation } from "../voice/use-dictation.ts";
import { imagesIn } from "./bring.ts";
import { clipboardKey, osc52Text } from "./clipboard-keys.ts";
import { CLOSED, type Picker } from "./images.tsx";
import { PHONE } from "./mobile.tsx";
import { attachToken, type TerminalInfo } from "./queries.ts";
import { drawOnGpu } from "./renderer.ts";
import { CLAUDE_WHEEL_LINES, dropBrokenMouseReports, placeTouchGestures } from "./touch.ts";

// One terminal's xterm and its socket: made per connection, attached with a token, kept alive by
// its own pings, and attached again on its own after a server or host restart. window.tsx draws
// the header, banners and dock around it.

export type Status =
  | { kind: "connecting" }
  | { kind: "reconnecting" }
  | { kind: "live" }
  // Another view holds the terminal: it was taken from this one, or this one asked without
  // taking it.
  | { kind: "elsewhere" }
  | { kind: "closed"; reason: string }
  | { kind: "missing" }
  // Lost when the PTY host restarted, and the server can bring it back.
  | { kind: "lost" };

export type Exit = {
  state: string;
  code: number | null;
  signal: string | null;
  error: string | null;
};

// The terminal's colours are the app's tokens (web/tokens.css), read when an xterm is made.
const token = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const theme = () => ({
  background: token("--term-bg"),
  foreground: token("--term-ink"),
  cursor: "#b8b4ff",
  selectionBackground: "#3b3a5c",
  // xterm's own auto-hiding scrollbar, brighter than its 20% default so it can be found.
  scrollbarSliderBackground: "rgba(228, 228, 234, 0.35)",
  scrollbarSliderHoverBackground: "rgba(228, 228, 234, 0.55)",
  scrollbarSliderActiveBackground: "rgba(184, 180, 255, 0.7)",
});

const CLOSE_REASON: Record<number, string> = {
  4003: "La ventana no daba abasto con la salida.",
  4004: "La salida desbordó el búfer; la pantalla se ha reiniciado.",
  4401: "La sesión no se ha podido autenticar.",
  4404: "La terminal ya no existe.",
};

// The server restarting (1001, 1006) or the PTY host being replaced (4503): the terminal
// itself is still there, so the window attaches again on its own. It keeps trying for
// RETRY_FOR_MS, long enough for a worker's reboot or a Tailscale restart; a terminal that is
// gone answers 404 and stops it at once.
const RETRY_CODES = new Set([1001, 1006, 4503]);
const RETRY_FOR_MS = 5 * 60_000;
// A browser cannot see protocol pings, so the window asks the server with its own, and any frame
// back counts as an answer. Shown again or back online, it keeps a socket that answers within
// PROBE_MS: same session, same scroll. VS Code and Phoenix never rebuild a healthy one on
// visibility either. While shown, it asks every BEAT_MS and replaces a socket silent for
// SILENT_MS, a path that died with the socket still open (a phone asleep, a dropped network).
const PROBE_MS = 4_000;
const BEAT_MS = 15_000;
const SILENT_MS = 30_000;

// What the view hands in: where to draw, what the terminal's key handler reads (refs, set once
// per connection), where Cmd+Shift+V opens the history and what a pasted image goes to.
type Options = {
  take: boolean;
  autoFocus: boolean;
  host: RefObject<HTMLDivElement | null>;
  // Set while a connection lives; the view focuses it.
  termRef: RefObject<Terminal | null>;
  font: RefObject<number>;
  harness: RefObject<TerminalInfo["harness"] | undefined>;
  dictate: RefObject<Dictation>;
  canDictate: RefObject<boolean>;
  setPicker: Dispatch<SetStateAction<Picker>>;
  pasteImages: RefObject<(images: File[]) => void>;
  // The capture key's: a selection typed into this terminal.
  captureImage: RefObject<() => void>;
  // What the view says over the screen, such as a copy the clipboard refused.
  onNotice: (notice: string) => void;
};

// An image in the Claude draft of this terminal, as the server last told: its number in the
// draft and a version that changes when the bytes do.
const DraftImages = z.array(
  z.strictObject({
    n: z.number().int(),
    v: z.number().int(),
    size: z.number().int().nonnegative(),
  }),
);
export type DraftImage = z.infer<typeof DraftImages>[number];

export function useTerminal(
  id: string,
  {
    take,
    autoFocus,
    host,
    termRef,
    font,
    harness,
    dictate,
    canDictate,
    setPicker,
    pasteImages,
    captureImage,
    onNotice,
  }: Options,
) {
  const sendInput = useRef<(data: string) => void>(() => {});
  const refit = useRef(() => {});
  const [status, setStatus] = useState<Status>({ kind: "connecting" });
  const [exit, setExit] = useState<Exit | null>(null);
  const [drafts, setDrafts] = useState<DraftImage[]>([]);
  const [attempt, setAttempt] = useState({ n: 0, take });

  // The refs and setters handed in are stable; a connection lives per id and attempt.
  // biome-ignore lint/correctness/useExhaustiveDependencies: as window.tsx had it inline.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: font.current,
      scrollback: 5000,
      // Scrollback moves 2x xterm's default per wheel or trackpad step.
      scrollSensitivity: 2,
      cursorBlink: true,
      disableStdin: true,
      theme: theme(),
      // For `unicode` below.
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Emoji take two cells, as Claude, Codex and Grok count them. With xterm's default
    // (Unicode 6) they take one, and every redraw of a line with emoji leaves stray characters.
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.open(el);
    const undraw = drawOnGpu(term);
    // On a touch screen the dock's bar types: a tap on the screen must not raise the keyboard
    // over the conversation. A keyboard plugged into a tablet still types into xterm.
    if (matchMedia(PHONE).matches) term.textarea?.setAttribute("inputmode", "none");
    // While a snapshot is written the screen keeps its size: a fit halfway would reflow half a
    // screen and resize the program under it. One fit follows the write.
    let restoring = false;
    const copy = (text: string) =>
      copyText(text).catch((err) => onNotice(`No se ha copiado: ${errorText(err)}.`));
    // A program's copy (OSC 52). Never while a snapshot is written: a reconnect does not copy
    // again.
    const copied = term.parser.registerOscHandler(52, (data) => {
      const text = restoring ? null : osc52Text(data);
      if (text) copy(text);
      return true;
    });
    // Fit within the server's bounds, so both ends always agree on the size.
    const coarse = matchMedia("(pointer: coarse)").matches;
    const fitToWindow = () => {
      if (restoring) return;
      const d = fit.proposeDimensions();
      if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows)) return;
      // While this view's dock bar has the focus on a touch screen, the phone's keyboard takes
      // the bottom of the page. The terminal keeps its rows, so the program does not redraw at
      // every keyboard open, and shows its last ones, where the prompt is.
      const active = document.activeElement;
      const typing =
        coarse &&
        active instanceof HTMLElement &&
        active.matches("input, textarea") &&
        Boolean(active.closest("[data-touch-dock]")) &&
        Boolean(el.parentElement?.parentElement?.contains(active));
      const { cols, rows } = clampSize(d.cols, typing ? Math.max(d.rows, term.rows) : d.rows);
      if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
      el.scrollTop = typing ? el.scrollHeight : 0;
    };
    fitToWindow();
    refit.current = fitToWindow;
    if (autoFocus) term.focus();
    termRef.current = term;

    let ws: WebSocket | undefined;
    let authed = false;
    let disposed = false;
    const send = (msg: unknown) => {
      if (authed && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };
    sendInput.current = (data) => send({ type: "input", data });
    const input = term.onData((typed) => {
      const data = dropBrokenMouseReports(typed);
      if (data) send({ type: "input", data });
    });
    const unplaceTouch = placeTouchGestures(el, () =>
      harness.current === "claude" && term.modes.mouseTrackingMode !== "none"
        ? CLAUDE_WHEEL_LINES
        : 1,
    );
    const keys = new DictationKeys(
      (action) => {
        const d = dictate.current;
        if (action === "start") d.start();
        else if (action === "stop") void d.stop();
        else d.cancel();
      },
      { enabled: () => canDictate.current, busy: () => dictate.current.phase !== "idle" },
    );
    // A hold whose keyup lands elsewhere is cancelled, not left recording.
    const dropHold = () => keys.blur();
    window.addEventListener("blur", dropHold);
    term.textarea?.addEventListener("blur", dropHold);
    const mac = isMacClient();
    term.attachCustomKeyEventHandler((event) => {
      // Before the dictation sees it: ⌃⌘ held for the capture key must not record. On the Mac
      // the helper takes ⌃⌘4 first, and the selection it opens takes the window's focus.
      if (isCaptureKey(event, mac)) {
        event.preventDefault();
        if (event.type === "keydown" && !event.repeat) {
          keys.blur();
          captureImage.current();
        }
        return false;
      }
      if (!keys.handle(event)) {
        event.preventDefault();
        return false;
      }
      const clip = clipboardKey(event, { mac, selected: term.hasSelection() });
      // The selection is written here: the browser's own copy needs a DOM selection, and
      // xterm's lives in its canvas. Cleared once copied, so the next Ctrl+C interrupts again,
      // as in Windows Terminal.
      if (clip === "copy") {
        event.preventDefault();
        if (event.type === "keydown") {
          copy(term.getSelection());
          term.clearSelection();
        }
        return false;
      }
      // False without preventDefault: xterm leaves the key and the browser pastes.
      if (clip === "paste") return false;
      // «Siguiente» is the app's: xterm leaves it, and the window's listener takes it.
      if (isNextKey(event, mac)) return false;
      // Cmd/Ctrl+Shift+V opens the image history instead of pasting the clipboard's text.
      if (
        event.key.toLowerCase() === "v" &&
        event.shiftKey &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey
      ) {
        event.preventDefault();
        if (event.type === "keydown") setPicker((p) => (p.open ? p : { ...CLOSED, open: true }));
        return false;
      }
      if (
        event.key !== "Enter" ||
        !event.shiftKey ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        event.isComposing
      )
        return true;
      event.preventDefault();
      // CSI u preserves Shift so interactive CLIs can insert a newline instead of submitting.
      if (event.type === "keydown") send({ type: "input", data: "\x1b[13;2u" });
      return false;
    });
    // The snapshot's own size is the server's already; only a fit is sent.
    const resize = term.onResize(({ cols, rows }) => {
      if (!restoring) send({ type: "resize", cols, rows });
    });
    const observer = new ResizeObserver(fitToWindow);
    observer.observe(el);
    // xterm drops a pasted image; caught before its textarea sees the paste, every image in
    // it is kept in the history and its path typed at once, without Enter. Text-only pastes
    // go on to xterm untouched.
    const onPaste = (event: ClipboardEvent) => {
      const { images } = imagesIn(event.clipboardData);
      if (images.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      pasteImages.current(images);
    };
    el.addEventListener("paste", onPaste, true);

    let tries = 0;
    // When the current run of failures began; 0 while attached.
    let failingSince = 0;
    // Each snapshot's write; the callback of one a newer snapshot replaced does nothing.
    let restores = 0;
    let takeNow = attempt.take;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Never replay keyboard input or carry an explicit takeover into a reconnect.
    const reconnect = () => setAttempt((a) => ({ n: a.n + 1, take: false }));
    // Set once this server answers a ping: an older one does not, and its windows reconnect on
    // waking as before.
    let beats = false;
    let heard = 0;
    let probe: ReturnType<typeof setTimeout> | undefined;
    const ask = (within: number) => {
      if (probe) return;
      const asked = Date.now();
      send({ type: "ping" });
      probe = setTimeout(() => {
        probe = undefined;
        if (!disposed && heard < asked) reconnect();
      }, within);
    };
    const retry = (reason: string) => {
      failingSince ||= Date.now();
      if (Date.now() - failingSince > RETRY_FOR_MS) {
        setStatus({ kind: "closed", reason });
        return;
      }
      setStatus({ kind: "reconnecting" });
      timer = setTimeout(connect, retryDelay(tries++));
    };
    // The token request is inside the retry too: while the server restarts, fetch fails.
    const connect = () =>
      attachToken(id)
        .then(({ token }) => {
          if (disposed) return;
          const scheme = location.protocol === "https:" ? "wss" : "ws";
          ws = new WebSocket(
            `${scheme}://${location.host}${machineUrl(`/api/terminals/${encodeURIComponent(id)}/ws`)}`,
          );
          ws.binaryType = "arraybuffer";
          // The token is always the first message; nothing else is sent until the snapshot.
          // A take the user asked for holds until an attach lands; once live, reconnects never
          // take, so a lost race ends as busy instead of stealing the terminal back.
          const take = takeNow;
          ws.onopen = () => ws?.send(JSON.stringify({ type: "auth", token, take }));
          ws.onmessage = (event) => {
            heard = Date.now();
            if (typeof event.data !== "string") {
              term.write(new Uint8Array(event.data as ArrayBuffer));
              return;
            }
            const msg = JSON.parse(event.data);
            if (msg.type === "pong") {
              beats = true;
            } else if (msg.type === "snapshot") {
              authed = true;
              term.options.disableStdin = false;
              tries = 0;
              failingSince = 0;
              takeNow = false;
              const restore = ++restores;
              restoring = true;
              term.reset();
              term.resize(msg.cols, msg.rows);
              term.write(msg.data, () => {
                if (disposed || restore !== restores) return;
                restoring = false;
                fitToWindow();
              });
              setStatus({ kind: "live" });
              // Whether this server answers pings.
              if (!beats) send({ type: "ping" });
            } else if (msg.type === "exit") {
              setExit(msg);
            } else if (msg.type === "drafts") {
              setDrafts(DraftImages.safeParse(msg.images).data ?? []);
            } else if (msg.type === "takeover" || msg.type === "busy") {
              setStatus({ kind: "elsewhere" });
            }
          };
          ws.onclose = (event) => {
            if (disposed) return;
            authed = false;
            term.options.disableStdin = true;
            if (RETRY_CODES.has(event.code)) {
              retry("Se ha cortado la conexión.");
              return;
            }
            setStatus((s) =>
              s.kind === "elsewhere" || event.code === 4001 || event.code === 4409
                ? { kind: "elsewhere" }
                : event.code === 4404
                  ? { kind: "missing" }
                  : {
                      kind: "closed",
                      reason: CLOSE_REASON[event.code] ?? "Se ha cortado la conexión.",
                    },
            );
          };
        })
        .catch((err) => {
          if (disposed) return;
          if (err instanceof ApiError && err.status === 404)
            setStatus({ kind: err.code === "lost" ? "lost" : "missing" });
          // No answer, or a 5xx while the server or the PTY host comes back.
          else if (!(err instanceof ApiError) || err.status >= 500) retry(errorText(err));
          else setStatus({ kind: "closed", reason: err.message });
        });

    // Shown again or back online: a socket may look open after background suspension and be
    // dead. One that answers is kept; any other attaches again.
    const wake = () => {
      if (document.visibilityState !== "visible") return;
      if (!beats || !authed || ws?.readyState !== WebSocket.OPEN) return reconnect();
      clearTimeout(probe);
      probe = undefined;
      ask(PROBE_MS);
    };
    const beat = setInterval(() => {
      if (beats && authed && document.visibilityState === "visible") ask(SILENT_MS);
    }, BEAT_MS);
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    window.addEventListener("pageshow", wake);
    setStatus({ kind: "connecting" });
    setExit(null);
    setDrafts([]);
    connect();

    return () => {
      disposed = true;
      sendInput.current = () => {};
      refit.current = () => {};
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("pageshow", wake);
      clearInterval(beat);
      clearTimeout(probe);
      clearTimeout(timer);
      ws?.close(1000, "window closed");
      observer.disconnect();
      el.removeEventListener("paste", onPaste, true);
      window.removeEventListener("blur", dropHold);
      term.textarea?.removeEventListener("blur", dropHold);
      copied.dispose();
      input.dispose();
      unplaceTouch();
      resize.dispose();
      term.dispose();
      undraw();
      termRef.current = null;
    };
  }, [id, attempt, autoFocus]);

  // Attaches again: `take` displaces the view holding the terminal (an explicit «Traer aquí»).
  const reattach = (take: boolean) => setAttempt((a) => ({ n: a.n + 1, take }));
  return { sendInput, refit, status, exit, reattach, drafts };
}
