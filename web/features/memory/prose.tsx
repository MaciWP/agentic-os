import { cn } from "cn";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Markdown as reading text: Inter at 15px with room between lines, mono only for code. The
// document's own h1 is the page title, so a heading inside the body starts one step lower.
const PROSE: Components = {
  h1: ({ node: _, ...p }) => <h2 className="text-[18px] font-semibold tracking-[-0.01em]" {...p} />,
  h2: ({ node: _, ...p }) => <h2 className="text-[16px] font-semibold" {...p} />,
  h3: ({ node: _, ...p }) => <h3 className="text-[15px] font-semibold" {...p} />,
  a: ({ node: _, ...p }) => (
    <a
      className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
      target="_blank"
      rel="noreferrer"
      {...p}
    />
  ),
  ul: ({ node: _, className, ...p }) => (
    <ul
      className={cn(
        "flex list-disc flex-col gap-1.5 pl-5 marker:text-ink-2",
        className === "contains-task-list" && "list-none pl-0",
      )}
      {...p}
    />
  ),
  ol: ({ node: _, ...p }) => (
    <ol className="flex list-decimal flex-col gap-1.5 pl-5 marker:text-ink-2" {...p} />
  ),
  input: ({ node: _, ...p }) => (
    <input {...p} className="mr-2 size-3.5 translate-y-[2px] accent-[var(--accent)]" />
  ),
  blockquote: ({ node: _, ...p }) => (
    <blockquote className="border-l-2 border-line pl-4 text-ink-2" {...p} />
  ),
  code: ({ node: _, ...p }) => (
    <code
      className="rounded-[4px] bg-[var(--hover)] px-1 py-px font-mono text-[0.86em] text-ink"
      {...p}
    />
  ),
  pre: ({ node: _, ...p }) => (
    <pre
      className="overflow-x-auto rounded-md border border-line bg-panel px-4 py-3 font-mono text-[12.5px] leading-[1.6] [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[1em]"
      {...p}
    />
  ),
  table: ({ node: _, ...p }) => (
    <div className="overflow-x-auto rounded-md border border-line">
      <table className="w-full text-[13.5px]" {...p} />
    </div>
  ),
  th: ({ node: _, ...p }) => (
    <th
      className="border-b border-line bg-panel px-3 py-1.5 text-left text-[12px] font-medium text-ink-2"
      {...p}
    />
  ),
  td: ({ node: _, ...p }) => <td className="border-t border-line px-3 py-1.5 align-top" {...p} />,
  hr: () => <hr className="border-line" />,
};

// A leading YAML block (harness memory carries one) is metadata, not reading text.
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

// `className` adds to the container (a chat reads tighter and at its own size); `frontMatter`
// off reads a leading `---` block as the text it is, as an agent's answer may start with one.
// `components` replaces single elements, as the code tile does for links and images that
// point into the checkout.
export function Prose({
  text,
  className,
  frontMatter = true,
  components,
}: {
  text: string;
  className?: string;
  frontMatter?: boolean;
  components?: Components;
}) {
  const meta = frontMatter ? text.match(FRONT_MATTER) : null;
  return (
    <div
      className={cn(
        "max-w-[68ch] text-[15px] leading-[1.65] text-ink [&>*+*]:mt-4 [&>h2]:mt-8 [&>h3]:mt-6",
        className,
      )}
    >
      {meta && (
        <details className="text-[12px] text-ink-2">
          <summary className="cursor-default select-none">Metadatos</summary>
          <pre className="mt-2 overflow-x-auto rounded-md border border-line bg-panel px-3 py-2 font-mono text-[12px] leading-[1.6] whitespace-pre-wrap">
            {meta[1]}
          </pre>
        </details>
      )}
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={components ? { ...PROSE, ...components } : PROSE}
      >
        {meta ? text.slice(meta[0].length) : text}
      </Markdown>
    </div>
  );
}
