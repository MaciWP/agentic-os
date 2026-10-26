// PTY reads can end in the middle of an escape sequence or a UTF-8 character.
// The headless screen copes (its parser is stateful), but a snapshot taken at that point
// would leave the client parsing the rest of the sequence as text. So both only ever
// see complete units: the incomplete tail is held until the next read completes it.

const ESC = 0x1b;
const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;
// String sequences: OSC ], DCS P, SOS X, PM ^, APC _. They end at BEL or ST (ESC \).
const STRING_STARTS = new Set([0x5d, 0x50, 0x58, 0x5e, 0x5f]);
// An unterminated sequence longer than this is released as is. A snapshot taken inside it
// can show a broken screen until the program redraws.
// ponytail: 1 MB covers OSC titles, hyperlinks and clipboard; inline images above it can break
// a reattach, stream-parse string sequences if a harness starts sending them.
export const MAX_HOLD = 1024 * 1024;

const isIntermediate = (b: number) => b >= 0x20 && b <= 0x2f;

function escapeComplete(bytes: Uint8Array, at: number): boolean {
  const kind = bytes[at + 1];
  if (kind === undefined) return false;
  if (kind === 0x5b) {
    // C0 controls inside a CSI are executed without ending it; only a final byte, or
    // CAN/SUB (which cancel it), does.
    for (let i = at + 2; i < bytes.length; i++) {
      const b = bytes[i] ?? 0;
      if ((b >= 0x40 && b <= 0x7e) || b === CAN || b === SUB) return true;
    }
    return false;
  }
  // `at` is the last ESC, so only BEL can still terminate the string.
  if (STRING_STARTS.has(kind)) return bytes.indexOf(BEL, at + 2) >= 0;
  if (isIntermediate(kind)) {
    let i = at + 1;
    while (i < bytes.length && isIntermediate(bytes[i] ?? 0)) i++;
    return i < bytes.length;
  }
  return true;
}

// Index where the incomplete trailing unit starts, or bytes.length if all is complete.
export function completeLength(bytes: Uint8Array): number {
  const esc = bytes.lastIndexOf(ESC);
  if (esc >= 0 && !escapeComplete(bytes, esc)) return esc;
  for (let i = bytes.length - 1; i >= Math.max(0, bytes.length - 4); i--) {
    const b = bytes[i] ?? 0;
    if ((b & 0xc0) === 0x80) continue;
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return bytes.length - i < need ? i : bytes.length;
  }
  return bytes.length;
}

export class Splitter {
  private held = new Uint8Array(0);

  get pending(): boolean {
    return this.held.length > 0;
  }

  push(chunk: Uint8Array): Uint8Array {
    const all = this.held.length ? concat(this.held, chunk) : chunk;
    let cut = completeLength(all);
    if (all.length - cut > MAX_HOLD) cut = all.length;
    this.held = all.slice(cut);
    return all.subarray(0, cut);
  }

  flush(): Uint8Array {
    const held = this.held;
    this.held = new Uint8Array(0);
    return held;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
