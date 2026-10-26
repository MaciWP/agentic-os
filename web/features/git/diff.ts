export type Segment = { text: string; changed: boolean };

export type DiffLine = {
  kind: "meta" | "hunk" | "add" | "del" | "context";
  text: string;
  // Line numbers in the old and the new file; null where the line has no side there.
  old: number | null;
  new: number | null;
  // The hunk the line belongs to, counted from 0; null for the file header.
  hunk: number | null;
  // Within a changed pair, which words changed; absent when the line has no partner.
  words?: Segment[];
};

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// A unified diff, one class per line, with each side's line numbers taken from the hunk
// headers. The file headers (`---`/`+++`) are meta, not changes. A run of removed lines
// followed by added ones is paired line by line, and each pair marks the words that differ.
export function parseDiff(diff: string): DiffLine[] {
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let inHunk = false;
  let hunk = -1;
  let oldNo = 0;
  let newNo = 0;
  const out = lines.map((text): DiffLine => {
    const none = { old: null, new: null };
    if (text.startsWith("@@")) {
      inHunk = true;
      hunk++;
      const m = HUNK.exec(text);
      oldNo = Number(m?.[1] ?? 0);
      newNo = Number(m?.[2] ?? 0);
      return { kind: "hunk", text, ...none, hunk };
    }
    if (text.startsWith("diff ")) inHunk = false;
    if (!inHunk) return { kind: "meta", text, ...none, hunk: null };
    if (text.startsWith("+")) return { kind: "add", text, old: null, new: newNo++, hunk };
    if (text.startsWith("-")) return { kind: "del", text, old: oldNo++, new: null, hunk };
    // "\ No newline at end of file" belongs to the hunk but is not content.
    if (text.startsWith("\\")) return { kind: "meta", text, ...none, hunk };
    return { kind: "context", text, old: oldNo++, new: newNo++, hunk };
  });
  const budget = { left: MAX_COMPARISONS };
  for (const [del, add] of changedPairs(out)) {
    const [a, b] = wordDiff(del.text.slice(1), add.text.slice(1), budget);
    del.words = a;
    add.words = b;
  }
  return out;
}

// Each removed line with the added line in the same place of the run that follows it.
function changedPairs(lines: DiffLine[]): [DiffLine, DiffLine][] {
  const pairs: [DiffLine, DiffLine][] = [];
  let i = 0;
  while (i < lines.length) {
    const dels: DiffLine[] = [];
    while (lines[i]?.kind === "del") dels.push(lines[i++] as DiffLine);
    const adds: DiffLine[] = [];
    while (lines[i]?.kind === "add") adds.push(lines[i++] as DiffLine);
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      pairs.push([dels[k] as DiffLine, adds[k] as DiffLine]);
    }
    if (dels.length === 0 && adds.length === 0) i++;
  }
  return pairs;
}

export type SplitRow =
  | { kind: "full"; line: DiffLine }
  | { kind: "pair"; left: DiffLine | null; right: DiffLine | null };

// The side-by-side view: context on both sides, a removed run on the left beside the added
// run that follows it, headers across the whole width.
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as DiffLine;
    if (line.kind === "meta" || line.kind === "hunk") {
      rows.push({ kind: "full", line });
      i++;
      continue;
    }
    if (line.kind === "context") {
      rows.push({ kind: "pair", left: line, right: line });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    while (lines[i]?.kind === "del") dels.push(lines[i++] as DiffLine);
    const adds: DiffLine[] = [];
    while (lines[i]?.kind === "add") adds.push(lines[i++] as DiffLine);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      rows.push({ kind: "pair", left: dels[k] ?? null, right: adds[k] ?? null });
    }
  }
  return rows;
}

const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
// Past this many tokens a side, the whole line counts as changed: the table grows as the
// product of both lengths.
const MAX_TOKENS = 400;
// Token comparisons for a whole diff. A diff at the size cap could take a few hundred ms to
// mark; past this, the remaining pairs are marked whole.
const MAX_COMPARISONS = 1_000_000;

// The words two lines do not share, by the longest common run of tokens. The comparisons it
// makes are taken from `budget`; a pair that does not fit is marked whole.
export function wordDiff(
  a: string,
  b: string,
  budget = { left: Number.POSITIVE_INFINITY },
): [Segment[], Segment[]] {
  const x = a.match(TOKEN) ?? [];
  const y = b.match(TOKEN) ?? [];
  const cost = x.length * y.length;
  if (x.length > MAX_TOKENS || y.length > MAX_TOKENS || cost > budget.left) {
    return [[{ text: a, changed: true }], [{ text: b, changed: true }]];
  }
  budget.left -= cost;
  // lcs[i][j]: the common length of x[i..] and y[j..].
  const lcs = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      const row = lcs[i] as Uint16Array;
      row[j] =
        x[i] === y[j]
          ? ((lcs[i + 1] as Uint16Array)[j + 1] as number) + 1
          : Math.max((lcs[i + 1] as Uint16Array)[j] as number, row[j + 1] as number);
    }
  }
  const left: Segment[] = [];
  const right: Segment[] = [];
  const push = (to: Segment[], text: string, changed: boolean) => {
    const last = to.at(-1);
    if (last && last.changed === changed) last.text += text;
    else to.push({ text, changed });
  };
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      push(left, x[i] as string, false);
      push(right, y[j] as string, false);
      i++;
      j++;
    } else if (
      ((lcs[i + 1] as Uint16Array)[j] as number) >= ((lcs[i] as Uint16Array)[j + 1] as number)
    ) {
      push(left, x[i++] as string, true);
    } else {
      push(right, y[j++] as string, true);
    }
  }
  while (i < x.length) push(left, x[i++] as string, true);
  while (j < y.length) push(right, y[j++] as string, true);
  return [left, right];
}

// How many lines the diff adds and removes.
export function diffStats(lines: DiffLine[]) {
  let add = 0;
  let del = 0;
  for (const l of lines) {
    if (l.kind === "add") add++;
    else if (l.kind === "del") del++;
  }
  return { add, del };
}
