import type { ReactNode } from "react";
import { type AdfNode, isNode } from "../../../shared/adf.ts";

// Jira content is untrusted: render ADF straight to React elements (no innerHTML) and only
// link http(s) URLs. Unknown nodes keep their text, like the server-side Markdown converter.

export function safeHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function withMarks(node: AdfNode, key: number): ReactNode {
  let out: ReactNode = node.text ?? "";
  for (const m of node.marks ?? []) {
    if (m.type === "code") out = <code className="adf-code">{out}</code>;
    else if (m.type === "strong") out = <strong>{out}</strong>;
    else if (m.type === "em") out = <em>{out}</em>;
    else if (m.type === "strike") out = <s>{out}</s>;
    else if (m.type === "underline") out = <u>{out}</u>;
    else if (m.type === "link") {
      const href = safeHref(m.attrs?.href);
      if (href)
        out = (
          <a href={href} target="_blank" rel="noreferrer noopener" className="adf-link">
            {out}
          </a>
        );
    }
  }
  return <span key={key}>{out}</span>;
}

function children(node: AdfNode): ReactNode {
  return (node.content ?? []).filter(isNode).map(render);
}

const PANEL: Record<string, string> = {
  info: "border-primary/40 bg-primary/5",
  note: "border-primary/40 bg-primary/5",
  success: "border-ok/40 bg-ok/5",
  warning: "border-warn/50 bg-warn/10",
  error: "border-bad/40 bg-bad/5",
};

function render(node: AdfNode, key: number): ReactNode {
  const a = node.attrs ?? {};
  switch (node.type) {
    case "doc":
      return <div key={key}>{children(node)}</div>;
    case "text":
      return withMarks(node, key);
    case "hardBreak":
      return <br key={key} />;
    case "paragraph":
      return <p key={key}>{children(node)}</p>;
    case "heading": {
      const level = Math.min(Math.max(Number(a.level) || 1, 1), 6);
      const Tag = `h${Math.min(level + 1, 6)}` as "h2";
      return <Tag key={key}>{children(node)}</Tag>;
    }
    case "bulletList":
      return <ul key={key}>{children(node)}</ul>;
    case "orderedList":
      return <ol key={key}>{children(node)}</ol>;
    case "listItem":
      return <li key={key}>{children(node)}</li>;
    case "taskList":
      return (
        <ul key={key} className="adf-tasks">
          {children(node)}
        </ul>
      );
    case "taskItem":
      return (
        <li key={key}>
          <input type="checkbox" checked={a.state === "DONE"} readOnly disabled aria-hidden />
          <span>{children(node)}</span>
        </li>
      );
    case "codeBlock":
      return (
        <pre key={key} className="adf-pre">
          <code>{(node.content ?? []).map((n) => (isNode(n) ? (n.text ?? "") : "")).join("")}</code>
        </pre>
      );
    case "blockquote":
      return <blockquote key={key}>{children(node)}</blockquote>;
    case "panel":
      return (
        <div
          key={key}
          className={`my-2 rounded-md border px-3 py-2 ${PANEL[String(a.panelType)] ?? PANEL.info}`}
        >
          {children(node)}
        </div>
      );
    case "rule":
      return <hr key={key} />;
    case "expand":
    case "nestedExpand":
      return (
        <details key={key} className="my-2">
          <summary className="cursor-pointer text-ink-2">{String(a.title ?? "Detalles")}</summary>
          {children(node)}
        </details>
      );
    case "table":
      return (
        <div key={key} className="my-2 overflow-x-auto">
          <table>
            <tbody>{children(node)}</tbody>
          </table>
        </div>
      );
    case "tableRow":
      return <tr key={key}>{children(node)}</tr>;
    case "tableHeader":
      return <th key={key}>{children(node)}</th>;
    case "tableCell":
      return <td key={key}>{children(node)}</td>;
    case "mention":
      return (
        <span key={key} className="adf-chip">
          {String(a.text ?? "@usuario")}
        </span>
      );
    case "status":
      return (
        <span key={key} className="adf-chip uppercase">
          {String(a.text ?? "")}
        </span>
      );
    case "emoji":
      return <span key={key}>{String(a.text ?? a.shortName ?? "")}</span>;
    case "date": {
      const d = new Date(Number(a.timestamp));
      return <time key={key}>{Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("es")}</time>;
    }
    case "inlineCard":
    case "blockCard": {
      const href = safeHref(a.url);
      return href ? (
        <a key={key} href={href} target="_blank" rel="noreferrer noopener" className="adf-link">
          {href}
        </a>
      ) : null;
    }
    case "mediaSingle":
    case "mediaGroup":
      return (
        <p key={key} className="text-ink-2 italic">
          [adjunto: ábrelo en Jira]
        </p>
      );
    default:
      return node.content ? (
        <div key={key}>{children(node)}</div>
      ) : (
        <span key={key}>{node.text ?? ""}</span>
      );
  }
}

export function AdfView({ doc }: { doc: unknown }) {
  if (!isNode(doc)) return <p className="text-ink-2">Sin descripción.</p>;
  return <div className="adf">{render(doc, 0)}</div>;
}

// ACs arrive as the inline markdown that server/features/jira/adf.ts emits.
// Only code, strong and links are rendered; anything else stays literal text.
const INLINE_MD = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/g;

export function InlineMarkdown({ text }: { text: string }) {
  return text.split(INLINE_MD).map((part, i) => {
    const key = `${i}`;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
      return (
        <code key={key} className="adf-code">
          {part.slice(1, -1)}
        </code>
      );
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4)
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      const href = safeHref(link[2]);
      return href ? (
        <a key={key} href={href} target="_blank" rel="noreferrer noopener" className="adf-link">
          {link[1]}
        </a>
      ) : (
        link[1]
      );
    }
    return part;
  });
}
