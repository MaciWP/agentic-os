// sherpa-onnx boosts a transducer's hotwords only as the model's own tokens, space-separated, and
// it ships no tokenizer for Parakeet: this splits each term into the longest pieces of its
// `tokens.txt`, the SentencePiece way ("▁" opens a word). A term with a letter the model has no
// piece for is left out, since sherpa would reject the whole line.

export const vocabulary = (tokensTxt: string) =>
  new Set(tokensTxt.split("\n").flatMap((line) => line.split(" ")[0] || []));

function pieces(word: string, vocab: Set<string>): string[] | null {
  const out: string[] = [];
  let rest = `▁${word}`;
  while (rest) {
    let n = rest.length;
    while (n > 0 && !vocab.has(rest.slice(0, n))) n--;
    if (n === 0) return null;
    out.push(rest.slice(0, n));
    rest = rest.slice(n);
  }
  return out;
}

// "Agentic OS" → "▁Agent ic ▁OS"; terms are joined with "/", sherpa's separator.
export function hotwords(terms: string[], vocab: Set<string>): string {
  const lines: string[] = [];
  for (const term of terms) {
    const split = term
      .trim()
      .split(/\s+/)
      .map((w) => pieces(w, vocab));
    if (split.length && split.every((p) => p !== null)) lines.push(split.flat().join(" "));
  }
  return lines.join("/");
}
