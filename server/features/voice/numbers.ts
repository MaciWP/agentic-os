// The model spells numbers out ("mil setenta y siete"); a prompt wants digits (1077), and a
// Jira key is only found with them. Spanish cardinals up to 999 999. "Un", "una" and "uno"
// alone stay words: they are articles far more often than numbers.

const UNITS: Record<string, number> = {
  cero: 0,
  un: 1,
  uno: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
};
const TEENS: Record<string, number> = {
  diez: 10,
  once: 11,
  doce: 12,
  trece: 13,
  catorce: 14,
  quince: 15,
  dieciséis: 16,
  dieciseis: 16,
  diecisiete: 17,
  dieciocho: 18,
  diecinueve: 19,
  veinte: 20,
  veintiún: 21,
  veintiun: 21,
  veintiuno: 21,
  veintiuna: 21,
  veintidós: 22,
  veintidos: 22,
  veintitrés: 23,
  veintitres: 23,
  veinticuatro: 24,
  veinticinco: 25,
  veintiséis: 26,
  veintiseis: 26,
  veintisiete: 27,
  veintiocho: 28,
  veintinueve: 29,
};
const TENS: Record<string, number> = {
  treinta: 30,
  cuarenta: 40,
  cincuenta: 50,
  sesenta: 60,
  setenta: 70,
  ochenta: 80,
  noventa: 90,
};
const HUNDREDS: Record<string, number> = {
  cien: 100,
  ciento: 100,
  doscientos: 200,
  doscientas: 200,
  trescientos: 300,
  trescientas: 300,
  cuatrocientos: 400,
  cuatrocientas: 400,
  quinientos: 500,
  quinientas: 500,
  seiscientos: 600,
  seiscientas: 600,
  setecientos: 700,
  setecientas: 700,
  ochocientos: 800,
  ochocientas: 800,
  novecientos: 900,
  novecientas: 900,
};
const NUMBER_WORDS = [
  ...Object.keys(UNITS),
  ...Object.keys(TEENS),
  ...Object.keys(TENS),
  ...Object.keys(HUNDREDS),
  "mil",
].sort((a, b) => b.length - a.length);
const W = `(?:${NUMBER_WORDS.join("|")})`;
const edge = (s: string) => `(?<![\\p{L}\\p{N}])${s}(?![\\p{L}\\p{N}])`;
// A run of number words, with the "y" of "setenta y siete" between them.
const RUN = new RegExp(edge(`${W}(?:\\s+(?:${W}|y))*`), "giu");

const at = (table: Record<string, number>, w: string | undefined) =>
  w === undefined ? undefined : table[w];

// 0 to 999 from words[i]: [hundreds] [tens [y unit] | 10-29 | unit].
function group(words: string[], i: number): { value: number; next: number } | null {
  let value = 0;
  let j = i;
  const hundred = at(HUNDREDS, words[j]);
  if (hundred !== undefined) {
    value += hundred;
    j++;
  }
  const ten = at(TENS, words[j]);
  const teen = at(TEENS, words[j]);
  const unit = at(UNITS, words[j]);
  if (ten !== undefined) {
    value += ten;
    j++;
    const after = at(UNITS, words[j + 1]);
    if (words[j] === "y" && after !== undefined && after > 0) {
      value += after;
      j += 2;
    }
  } else if (teen !== undefined) {
    value += teen;
    j++;
  } else if (unit !== undefined) {
    value += unit;
    j++;
  }
  return j > i ? { value, next: j } : null;
}

// A whole number from words[i]: [group] mil [group], or a group alone.
function number(words: string[], i: number): { value: number; next: number } | null {
  const head = group(words, i);
  let j = head?.next ?? i;
  if (words[j] !== "mil") return head;
  const tail = group(words, j + 1);
  j = tail?.next ?? j + 1;
  return { value: (head?.value ?? 1) * 1000 + (tail?.value ?? 0), next: j };
}

export function numbersToDigits(text: string): string {
  return text.replace(RUN, (run) => {
    const original = run.split(/\s+/);
    const words = original.map((w) => w.toLowerCase());
    const out: string[] = [];
    for (let i = 0; i < words.length; ) {
      const found = number(words, i);
      const article = found && found.next === i + 1 && UNITS[words[i] as string] === 1;
      if (found && !article) {
        out.push(String(found.value));
        i = found.next;
      } else out.push(original[i++] as string);
    }
    return out.join(" ");
  });
}
