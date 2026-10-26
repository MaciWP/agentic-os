// A line added at the end of a Markdown section (`## Acuerdos`), before the next heading of that
// level or higher; a missing section is added at the end. Empty list items the template leaves
// (`- `, `- [ ] `) are replaced, never kept above the new line.
export function withLine(body: string, heading: string, line: string): string {
  const lines = body.replace(/\n+$/, "").split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return `${lines.join("\n")}\n\n${heading}\n${line}\n`;
  let end = lines.findIndex((l, i) => i > start && /^#{1,2} /.test(l));
  if (end === -1) end = lines.length;
  const section = lines.slice(start + 1, end).filter((l) => !/^-( \[ \])?$/.test(l.trim()));
  while (section.length > 0 && section[section.length - 1]?.trim() === "") section.pop();
  while (section.length > 0 && section[0]?.trim() === "") section.shift();
  const rest = lines.slice(end);
  const out = [
    ...lines.slice(0, start + 1),
    ...section,
    line,
    ...(rest.length ? ["", ...rest] : []),
  ];
  return `${out.join("\n")}\n`;
}
