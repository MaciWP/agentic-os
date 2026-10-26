import serializePkg from "@xterm/addon-serialize";
import unicode11Pkg from "@xterm/addon-unicode11";
import headlessPkg from "@xterm/headless";

// Both packages ship CommonJS; under Bun the named exports live on the default export.
const { Terminal } = headlessPkg as unknown as typeof import("@xterm/headless");
const { SerializeAddon } = serializePkg as unknown as typeof import("@xterm/addon-serialize");
const { Unicode11Addon } = unicode11Pkg as unknown as typeof import("@xterm/addon-unicode11");

export const SCROLLBACK = 5000;
// Detached fast output can queue up faster than the headless parser drains it.
export const MAX_QUEUED_BYTES = 16 * 1024 * 1024;

export type Snapshot = { data: string; cols: number; rows: number };

// Private xterm state read for the snapshot; pinned by @xterm/headless 6.0.0 and its tests.
type CoreState = {
  buffer?: { scrollTop?: number; scrollBottom?: number };
  coreService?: { isCursorHidden?: boolean };
};

type Item =
  | { kind: "data"; bytes: Uint8Array }
  | { kind: "reset" }
  | { kind: "resize"; cols: number; rows: number }
  | { kind: "attach"; run: (snapshot: Snapshot) => void }
  | { kind: "text"; lines: number; run: (text: string) => void };

// The real screen state of one terminal. One serial queue orders output, resizes and
// attaches, so a snapshot holds exactly the output before it and `live` gets exactly
// the output after it: no gaps, no duplicates.
export class Screen {
  private readonly term: InstanceType<typeof Terminal>;
  private readonly serializer = new SerializeAddon();
  private readonly queue: Item[] = [];
  private queuedBytes = 0;
  private busy = false;
  // Set when an overflow drops the backlog while a write is still being parsed.
  private staleInFlight = false;
  // Output bytes received so far, dropped ones included; never goes back.
  private written = 0;

  constructor(
    cols: number,
    rows: number,
    private readonly live: (bytes: Uint8Array) => void,
    private readonly onOverflow: () => void,
  ) {
    this.term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
    this.term.loadAddon(this.serializer as never);
    // Emoji take two cells, as the browser's xterm and the TUIs count them.
    this.term.loadAddon(new Unicode11Addon() as never);
    this.term.unicode.activeVersion = "11";
  }

  get seq(): number {
    return this.written;
  }

  // Whether the program asked for pasted text to be marked, as a real terminal does.
  get bracketedPaste(): boolean {
    return this.term.modes.bracketedPasteMode;
  }

  write(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.written += bytes.length;
    this.queuedBytes += bytes.length;
    if (this.queuedBytes > MAX_QUEUED_BYTES) {
      this.overflow();
      return;
    }
    this.queue.push({ kind: "data", bytes });
    this.pump();
  }

  resize(cols: number, rows: number): void {
    this.queue.push({ kind: "resize", cols, rows });
    this.pump();
  }

  attach(run: (snapshot: Snapshot) => void): void {
    this.queue.push({ kind: "attach", run });
    this.pump();
  }

  // The last `lines` rows as plain text, after exactly the output written before this call.
  text(lines: number, run: (text: string) => void): void {
    this.queue.push({ kind: "text", lines, run });
    this.pump();
  }

  dispose(): void {
    this.queue.length = 0;
    this.term.dispose();
  }

  // Drops the backlog and starts a clean screen; the next snapshot shows only new output.
  // The reset waits for the write being parsed, so none of the old output lands after it.
  private overflow(): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i]?.kind === "data") this.queue.splice(i, 1);
    }
    this.queuedBytes = 0;
    this.staleInFlight = this.busy;
    this.queue.unshift({ kind: "reset" });
    this.onOverflow();
    this.pump();
  }

  // The serializer restores content, cursor and the main modes, but not the scroll region
  // or a hidden cursor. TUIs rely on both, so they are appended from the screen's state.
  private snapshot(): Snapshot {
    let data = this.serializer.serialize();
    const core = (this.term as unknown as { _core?: CoreState })._core;
    const top = core?.buffer?.scrollTop ?? 0;
    const bottom = core?.buffer?.scrollBottom ?? this.term.rows - 1;
    const region = top !== 0 || bottom !== this.term.rows - 1;
    const origin = this.term.modes.originMode;
    if (region) data += `\x1b[${top + 1};${bottom + 1}r`;
    // DECSTBM and the serializer's trailing DECOM both home the cursor, so it is put back;
    // with origin mode on, rows count from the region.
    if (region || origin) {
      const { cursorX, cursorY } = this.term.buffer.active;
      const row = origin ? cursorY - top + 1 : cursorY + 1;
      data += `\x1b[${row};${cursorX + 1}H`;
    }
    if (core?.coreService?.isCursorHidden) data += "\x1b[?25l";
    return { data, cols: this.term.cols, rows: this.term.rows };
  }

  // Wrapped rows join the row they continue; blank rows at the end are dropped.
  private render(lines: number): string {
    const buffer = this.term.buffer.active;
    const rows: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && rows.length > 0) rows[rows.length - 1] += text;
      else rows.push(text);
    }
    while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
    return rows.slice(-lines).join("\n");
  }

  private pump(): void {
    while (!this.busy) {
      const item = this.queue.shift();
      if (!item) return;
      if (item.kind === "resize") {
        this.term.resize(item.cols, item.rows);
      } else if (item.kind === "attach") {
        item.run(this.snapshot());
      } else if (item.kind === "text") {
        item.run(this.render(item.lines));
      } else if (item.kind === "reset") {
        this.term.reset();
      } else {
        this.busy = true;
        const { bytes } = item;
        this.term.write(bytes, () => {
          if (!this.staleInFlight) this.queuedBytes -= bytes.length;
          this.staleInFlight = false;
          this.busy = false;
          this.live(bytes);
          this.pump();
        });
      }
    }
  }
}
