import { useEffect, useState } from "react";
import type { PaintRequest } from "./highlight.worker.ts";
import type { Painted } from "./tokens.ts";

export type { Painted, Token } from "./tokens.ts";

// The page's side of the highlight worker: one worker for every code tile, made with the
// first file, and a promise per text sent. A file paints in the worker, so a big one never
// freezes the page; a text replaced before its answer comes is simply not shown.
type Reply = { id: number; painted?: Painted; error?: string };

const channel = {
  worker: null as Worker | null,
  next: 0,
  waiting: new Map<number, { resolve: (p: Painted) => void; reject: (e: Error) => void }>(),
};

function worker(): Worker {
  if (channel.worker) return channel.worker;
  const w = new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" });
  w.addEventListener("message", (e: MessageEvent<Reply>) => {
    const { id, painted, error } = e.data;
    const waiting = channel.waiting.get(id);
    channel.waiting.delete(id);
    if (painted) waiting?.resolve(painted);
    else waiting?.reject(new Error(error ?? "highlight failed"));
  });
  // A worker that cannot start (or dies) leaves every waiting file plain, and the next file
  // starts a new one.
  w.addEventListener("error", () => {
    for (const { reject } of channel.waiting.values()) reject(new Error("highlight worker failed"));
    channel.waiting.clear();
    channel.worker = null;
  });
  channel.worker = w;
  return w;
}

export function paint(path: string, text: string): Promise<Painted> {
  const id = ++channel.next;
  return new Promise((resolve, reject) => {
    channel.waiting.set(id, { resolve, reject });
    worker().postMessage({ id, path, text } satisfies PaintRequest);
  });
}

// The painted form of this text, once the worker has it; null until then, for plain text
// whose grammar failed, and for no text (the editor paints its own). A new text keeps showing
// plain until its own answer.
export function usePainted(path: string, text: string | null): Painted | null {
  const [painted, setPainted] = useState<{ path: string; text: string; p: Painted } | null>(null);
  useEffect(() => {
    if (text === null) return;
    let live = true;
    paint(path, text).then(
      (p) => live && setPainted({ path, text, p }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [path, text]);
  return painted?.path === path && painted.text === text ? painted.p : null;
}
