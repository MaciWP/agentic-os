// Atlassian Document Format -> Markdown. Unknown nodes keep their text so nothing is lost.
import { type AdfMark, type AdfNode, isNode } from "../../../shared/adf.ts";

function applyMarks(text: string, marks: AdfMark[] = []): string {
  let out = text;
  for (const m of marks) {
    if (m.type === "code") out = `\`${out}\``;
    else if (m.type === "strong") out = `**${out}**`;
    else if (m.type === "em") out = `_${out}_`;
    else if (m.type === "strike") out = `~~${out}~~`;
    else if (m.type === "link" && typeof m.attrs?.href === "string")
      out = `[${out}](${m.attrs.href})`;
  }
  return out;
}

function inline(nodes: AdfNode[] = []): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case "text":
          return applyMarks(n.text ?? "", n.marks);
        case "hardBreak":
          return "\n";
        case "mention":
          return String(n.attrs?.text ?? "@user");
        case "emoji":
          return String(n.attrs?.text ?? n.attrs?.shortName ?? "");
        case "inlineCard":
          return String(n.attrs?.url ?? "");
        case "status":
          return `[${String(n.attrs?.text ?? "")}]`;
        case "date":
          return new Date(Number(n.attrs?.timestamp)).toISOString().slice(0, 10);
        default:
          return inline(n.content);
      }
    })
    .join("");
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line, i) => (i === 0 ? line : line ? `${" ".repeat(prefix.length)}${line}` : line))
    .join("\n");
}

function fence(body: string, lang: string): string {
  const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map((s) => s.length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${lang}\n${body}\n${ticks}`;
}

function block(n: AdfNode): string {
  switch (n.type) {
    case "paragraph":
      return inline(n.content);
    case "heading":
      return `${"#".repeat(Number(n.attrs?.level ?? 1))} ${inline(n.content)}`;
    case "bulletList":
    case "orderedList":
      return (n.content ?? [])
        .map((item, i) => {
          const prefix = n.type === "bulletList" ? "- " : `${i + 1}. `;
          return prefix + indent(blocks(item.content), prefix);
        })
        .join("\n");
    case "taskList":
      return (n.content ?? [])
        .map((item) => `- [${item.attrs?.state === "DONE" ? "x" : " "}] ${inline(item.content)}`)
        .join("\n");
    case "codeBlock":
      return fence(inline(n.content), String(n.attrs?.language ?? ""));
    case "blockquote":
      return blocks(n.content)
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    case "rule":
      return "---";
    case "panel":
      return blocks(n.content)
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    case "table":
      return table(n);
    case "mediaSingle":
    case "mediaGroup":
      return "_[adjunto]_";
    default:
      return n.content ? blocks(n.content) : inline([n]);
  }
}

function table(n: AdfNode): string {
  const rows = (n.content ?? []).map((row) =>
    (row.content ?? []).map((cell) =>
      blocks(cell.content).replace(/\n+/g, " ").replace(/\|/g, "\\|"),
    ),
  );
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  const [head = [], ...body] = rows;
  return [line(head), line(Array(width).fill("---")), ...body.map(line)].join("\n");
}

function blocks(nodes: AdfNode[] = []): string {
  return nodes
    .map(block)
    .filter((s) => s.length > 0)
    .join("\n\n");
}

export function adfToMarkdown(doc: unknown): string {
  if (!isNode(doc)) return "";
  return blocks(doc.type === "doc" ? doc.content : [doc]).trim();
}

// Optional enrichment: the list under an "acceptance criteria" heading, when present.
const AC_HEADING = /criterios de aceptaci[oó]n|acceptance criteria|\bdod\b/i;

export function extractAcceptanceCriteria(markdown: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => /^#{1,6}\s|^\*\*/.test(l) && AC_HEADING.test(l));
  if (start === -1) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line) || (/^\*\*.+\*\*$/.test(line.trim()) && items.length > 0)) break;
    const m = line.match(/^(?:[-*]|\d+\.)\s+(?:\[[ x]\]\s+)?(.*)$/);
    if (m?.[1]) items.push(m[1].trim());
  }
  return items;
}
