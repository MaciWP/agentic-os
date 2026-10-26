// The code tile's pure parts: the word under a click, quick open's ranking and the folders
// to unfold to show a file.

const WORD = /[\w$]/;

// The identifier around `offset` in `text`, or null when the click is not on one (a space, a
// bracket, a number).
export function wordAt(text: string, offset: number): string | null {
  let start = offset;
  let end = offset;
  while (start > 0 && WORD.test(text[start - 1] ?? "")) start--;
  while (end < text.length && WORD.test(text[end] ?? "")) end++;
  const word = text.slice(start, end);
  return /^[A-Za-z_$][\w$]*$/.test(word) ? word : null;
}

// A path's score for a typed query, or null when the letters do not all appear in order.
// Letters in the file name, right after a separator or one after another count more; a
// query found whole in the name counts most; a shorter path wins a tie.
export function fuzzyScore(path: string, query: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const p = path.toLowerCase();
  const nameAt = p.lastIndexOf("/") + 1;
  let score = p.slice(nameAt).includes(q) ? 20 : 0;
  let at = -1;
  let run = 0;
  for (const ch of q) {
    const i = p.indexOf(ch, at + 1);
    if (i < 0) return null;
    run = i === at + 1 ? run + 1 : 0;
    score +=
      1 + run * 2 + (i >= nameAt ? 2 : 0) + (i === 0 || "/._-".includes(p[i - 1] ?? "") ? 3 : 0);
    at = i;
  }
  return score - p.length / 100;
}

export function rankFiles(files: string[], query: string, limit = 50): string[] {
  if (!query.trim()) return files.slice(0, limit);
  const scored: [string, number][] = [];
  for (const f of files) {
    const s = fuzzyScore(f, query);
    if (s !== null) scored.push([f, s]);
  }
  return scored
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([f]) => f);
}

// Every folder above a file, outermost first: "a/b/c.ts" → ["a", "a/b"].
export function ancestors(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

// A malformed escape (`%zz`) stays as written instead of throwing.
export const decoded = (seg: string) => {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
};

// A link in a file, as a path below the checkout: "../b.md#x" from "docs/a/r.md" is "docs/b.md".
// Null for a link off the checkout: another site, an anchor in the same file, or one that
// climbs above the checkout.
export function resolveLink(from: string, href: string): string | null {
  if (/^[a-z][a-z\d+.-]*:|^\/\/|^#/i.test(href)) return null;
  const target = href.split(/[?#]/)[0] ?? "";
  if (!target) return null;
  const parts = target.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else if (seg && seg !== ".") parts.push(decoded(seg));
  }
  return parts.length ? parts.join("/") : null;
}
