// Atlassian Document Format, as Jira returns it. The server turns it into Markdown and the web
// renders it; both read nodes with the same guard.
export type AdfMark = { type: string; attrs?: Record<string, unknown> };
export type AdfNode = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: AdfMark[];
  content?: AdfNode[];
};

export function isNode(value: unknown): value is AdfNode {
  return typeof value === "object" && value !== null && typeof (value as AdfNode).type === "string";
}
