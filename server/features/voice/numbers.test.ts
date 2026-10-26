import { describe, expect, test } from "bun:test";
import { numbersToDigits } from "./numbers.ts";

describe("numbersToDigits", () => {
  test("spoken numbers become digits", () => {
    const cases: [string, string][] = [
      [
        "revisa los tres comentarios del doce de octubre",
        "revisa los 3 comentarios del 12 de octubre",
      ],
      ["ABC mil setenta y siete", "ABC 1077"],
      ["dos mil veintiséis", "2026"],
      ["ciento veinte y cuatrocientas cincuenta y una", "120 y 451"],
      ["cien mil", "100000"],
      ["novecientos noventa y nueve mil novecientos noventa y nueve", "999999"],
      ["Diez minutos", "10 minutos"],
      ["cero", "0"],
    ];
    for (const [heard, meant] of cases) expect(numbersToDigits(heard)).toBe(meant);
  });

  test("a 'y' joins tens and units only, never two numbers", () => {
    expect(numbersToDigits("dos y tres")).toBe("2 y 3");
    expect(numbersToDigits("treinta y uno")).toBe("31");
    expect(numbersToDigits("treinta y")).toBe("30 y");
  });

  test("un, una and uno alone stay words; inside a number they count", () => {
    expect(numbersToDigits("abre un ticket y una nota, uno de ellos")).toBe(
      "abre un ticket y una nota, uno de ellos",
    );
    expect(numbersToDigits("veintiún días y cuarenta y una horas")).toBe("21 días y 41 horas");
  });

  test("only whole words: numbers inside other words are left alone", () => {
    expect(numbersToDigits("dosis, tresillo y milano")).toBe("dosis, tresillo y milano");
    expect(numbersToDigits("sin números aquí")).toBe("sin números aquí");
  });
});
