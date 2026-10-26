import { z } from "zod";

// Terminal size bounds, shared so the window never asks for a size the server would change.
export const COLS = { min: 20, max: 500 };
export const ROWS = { min: 5, max: 200 };

const clamp = (n: number, { min, max }: { min: number; max: number }) =>
  Math.min(max, Math.max(min, Math.round(n)));

export const clampSize = (cols: number, rows: number) => ({
  cols: clamp(cols, COLS),
  rows: clamp(rows, ROWS),
});

// Terminals running at once: the server refuses one more, and the status bar shows the count
// against it.
export const MAX_RUNNING = 20;

// A pasted image: the types a terminal takes and their cap, checked in the page and again on
// the server.
// ponytail: 10 MB covers Retina screenshots; raise it when a paste is refused for size.
export const PASTE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type PasteImageType = (typeof PASTE_IMAGE_TYPES)[number];
export const MAX_PASTE_IMAGE_BYTES = 10 << 20;
// How many images of the history one bring types, and an image id: its source, then a file
// name. The server resolves it; this only checks its shape.
export const MAX_BRING_IMAGES = 5;
export const IMAGE_ID = /^(pasted|captured|folder):[^/\\\0]+$/;

// A note on a diff line or range, sent to the agent working in that checkout. The quoted lines
// anchor it: line numbers move when the agent edits, the text says which lines were meant.
export const NOTE_KINDS = ["change", "question", "nit", "keep"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export const MAX_NOTE_LINES = 20;
export const MAX_BRING_NOTES = 50;
export const DiffNote = z
  .strictObject({
    // Relative to the checkout, as git prints it: never absolute, never climbing out.
    path: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (p) => !p.startsWith("/") && !p.split("/").includes("..") && !p.includes("\0"),
        "bad path",
      ),
    // "old" for a removed line, whose number is the old file's.
    side: z.enum(["old", "new"]),
    start: z.number().int().positive(),
    end: z.number().int().positive(),
    quote: z.array(z.string().max(500)).min(1).max(MAX_NOTE_LINES),
    kind: z.enum(NOTE_KINDS),
    text: z.string().trim().min(1).max(2000),
  })
  .refine((n) => n.end >= n.start, "end before start");
export type DiffNote = z.infer<typeof DiffNote>;

// The keys a phone keyboard lacks, by name: a client sends names and the server writes their
// bytes, never free bytes. The phone's dock shows them in this order.
export const TERMINAL_KEYS = {
  esc: "\x1b",
  tab: "\t",
  "shift-tab": "\x1b[Z",
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  right: "\x1b[C",
  enter: "\r",
  "ctrl-c": "\x03",
} as const;
export type TerminalKey = keyof typeof TERMINAL_KEYS;
export const TERMINAL_KEY_NAMES = Object.keys(TERMINAL_KEYS) as [TerminalKey, ...TerminalKey[]];

// What a phone reads instead of the terminal: an agent's conversation as its harness records
// it, oldest first. Tool calls, thinking and the harness's own records stay out.
export const ConversationMessage = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  at: z.string().nullable(),
});
export type ConversationMessage = z.infer<typeof ConversationMessage>;
export const Conversation = z.object({ messages: z.array(ConversationMessage) });
export const CONVERSATION = { limit: 40, max: 200 };
