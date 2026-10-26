import { Fragment, type MouseEvent, useLayoutEffect, useMemo, useRef } from "react";
import type { Token } from "./highlight.ts";
import { wordAt } from "./nav.ts";

// Every line is this tall (Tailwind leading-5) and the code starts this far down (py-2), so a
// line number is a scroll offset and a click's height is a line, with no measuring.
const LINE_PX = 20;
const PAD_PX = 8;

const caretAt = (x: number, y: number): { node: Node; offset: number } | null => {
  const p = document.caretPositionFromPoint?.(x, y);
  if (p) return { node: p.offsetNode, offset: p.offset };
  const r = document.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
};

const style = (t: Token) => ({
  color: t.color,
  ...(t.fontStyle && t.fontStyle & 1 && { fontStyle: "italic" }),
  ...(t.fontStyle && t.fontStyle & 2 && { fontWeight: 600 }),
  ...(t.fontStyle && t.fontStyle & 4 && { textDecoration: "underline" }),
});

// One file's text, read only: line numbers that stay put when scrolling sideways, the code
// as plain text until its tokens come (the same lines, so nothing moves). Two <pre>s, not a
// row per line: a 20 000-line file stays two elements plus its tokens. ⌘/Ctrl+click on a name
// asks where it is defined. Focusable, so the keyboard scrolls it too.
export function CodeViewer({
  label,
  text,
  tokens,
  line,
  seq,
  onWord,
}: {
  label: string;
  text: string;
  // The text's tokens, or null while they come and for plain text.
  tokens: Token[][] | null;
  // The line to show and mark; `seq` changes each time it is asked for, so asking again for
  // the same line scrolls back to it while a poll that brings new text does not.
  line: number | null;
  seq: number;
  onWord: (name: string, line: number) => void;
}) {
  const scroller = useRef<HTMLElement>(null);
  const lines = useMemo(() => {
    const all = text.split("\n");
    if (all.length > 1 && all.at(-1) === "") all.pop();
    return all;
  }, [text]);
  const numbers = useMemo(() => lines.map((_, i) => i + 1).join("\n"), [lines]);

  const shown = useRef(-1);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || shown.current === seq) return;
    shown.current = seq;
    el.scrollTop = line ? Math.max(0, PAD_PX + (line - 1) * LINE_PX - el.clientHeight / 3) : 0;
  }, [seq, line]);

  const onClick = (e: MouseEvent<HTMLPreElement>) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const caret = caretAt(e.clientX, e.clientY);
    const word = caret?.node.textContent ? wordAt(caret.node.textContent, caret.offset) : null;
    if (!word) return;
    e.preventDefault();
    const top = e.currentTarget.getBoundingClientRect().top;
    onWord(word, Math.max(1, Math.floor((e.clientY - top - PAD_PX) / LINE_PX) + 1));
  };

  return (
    <section
      ref={scroller}
      data-code-scroll
      aria-label={label}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region takes focus so the keyboard can scroll it
      tabIndex={0}
      className="min-h-0 flex-1 overflow-auto bg-bg font-mono text-[12px] leading-5 [tab-size:4] focus-visible:-outline-offset-2"
    >
      <div className="flex min-h-full w-max min-w-full">
        <pre
          aria-hidden
          className="sticky left-0 z-10 shrink-0 select-none border-line border-r bg-bg py-2 pr-3 pl-3 text-right text-ink-2/60"
        >
          {numbers}
        </pre>
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: ⌘-click is a mouse shortcut; the keyboard opens files from the tree and ⌘P */}
        <pre
          data-code-text
          className="relative flex-1 py-2 pr-6 pl-3 text-ink"
          title="⌘/Ctrl+clic en un nombre: ir a su definición"
          onClick={onClick}
        >
          {line !== null && line <= lines.length && (
            <span
              aria-hidden
              data-code-line={line}
              className="pointer-events-none absolute inset-x-0 h-5 bg-[var(--selected)]"
              style={{ top: PAD_PX + (line - 1) * LINE_PX }}
            />
          )}
          <code className="relative">
            {tokens
              ? tokens.map((row, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a line's index is its identity
                  <Fragment key={i}>
                    {row.map((t, j) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: a token's place is its identity
                      <span key={j} style={style(t)}>
                        {t.content}
                      </span>
                    ))}
                    {i < tokens.length - 1 && "\n"}
                  </Fragment>
                ))
              : text}
          </code>
        </pre>
      </div>
    </section>
  );
}
