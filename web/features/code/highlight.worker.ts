import { paint } from "./tokens.ts";

// The code tile's highlighter, off the page's thread: one message per file text, answered
// with its grammar and tokens, or with why it could not.
export type PaintRequest = { id: number; path: string; text: string };

const port = self as unknown as Worker;

port.addEventListener("message", (e: MessageEvent<PaintRequest>) => {
  const { id, path, text } = e.data;
  paint(path, text).then(
    (painted) => port.postMessage({ id, painted }),
    (err: unknown) => port.postMessage({ id, error: String(err) }),
  );
});
