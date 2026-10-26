import { describe, expect, test } from "bun:test";
import { parseTask } from "./task-parse.ts";

// Friday 16 October 2026, 10:00 local.
const NOW = new Date(2026, 9, 16, 10, 0);
const p = (text: string, drop: string[] = []) =>
  parseTask(text, NOW, new Set(drop as ("day" | "time" | "priority" | "about")[]));

describe("parseTask", () => {
  test("nothing found: the defaults", () => {
    expect(p("Llamar a Ana")).toEqual({
      title: "Llamar a Ana",
      dueOn: null,
      dueHm: null,
      priority: 0,
      about: null,
      chips: [],
    });
  });

  test("«mañana 16:00 llamar !» is tomorrow at four, urgent", () => {
    expect(p("mañana 16:00 llamar !")).toMatchObject({
      title: "llamar",
      dueOn: "2026-10-17",
      dueHm: "16:00",
      priority: 1,
    });
  });

  test("the longest day words win, and «por la mañana» is not tomorrow", () => {
    expect(p("pasado mañana revisar").dueOn).toBe("2026-10-18");
    expect(p("manana revisar").dueOn).toBe("2026-10-17");
    expect(p("revisar por la mañana").dueOn).toBeNull();
    expect(p("hoy enviar").dueOn).toBe("2026-10-16");
  });

  test("a weekday is the next one; today's weekday is a week away", () => {
    expect(p("el lunes demo").dueOn).toBe("2026-10-19");
    expect(p("viernes cierre").dueOn).toBe("2026-10-23");
    expect(p("el miércoles").title).toBe("el miércoles");
    expect(p("informe el miércoles").title).toBe("informe");
  });

  test("a day of the month already gone is next month's; a date with a slash too", () => {
    expect(p("pagar el 20").dueOn).toBe("2026-10-20");
    expect(p("pagar el 3").dueOn).toBe("2026-11-03");
    expect(p("pagar el día 31").dueOn).toBe("2026-10-31");
    expect(p("factura 5/11").dueOn).toBe("2026-11-05");
    expect(p("factura 1/10").dueOn).toBe("2027-10-01");
  });

  test("«a las 1–7» is afternoon unless said otherwise; a time alone is today", () => {
    expect(p("llamar a las 4")).toMatchObject({
      dueHm: "16:00",
      dueOn: "2026-10-16",
      title: "llamar",
    });
    expect(p("llamar a las 9")).toMatchObject({ dueHm: "09:00" });
    expect(p("tren a las 6 de la mañana").dueHm).toBe("06:00");
    expect(p("demo a las 5:30").dueHm).toBe("17:30");
    expect(p("demo 9:15").dueHm).toBe("09:15");
    expect(p("demo 16h").dueHm).toBe("16:00");
  });

  test("urgency words stay in the title; «no urgente» is not urgent", () => {
    expect(p("revisar contrato urgente")).toMatchObject({
      priority: 1,
      title: "revisar contrato urgente",
    });
    expect(p("revisar, no urgente").priority).toBe(0);
    expect(p("importante: firmar").priority).toBe(1);
    expect(p("firmar!")).toMatchObject({ priority: 1, title: "firmar" });
    expect(p("¡Hola! qué tal").priority).toBe(0);
  });

  test("a ticket key is what the task is about and stays in the title", () => {
    expect(p("revisar PR de ABC-123")).toMatchObject({
      about: "ABC-123",
      title: "revisar PR de ABC-123",
    });
    expect(p("revisar abc-123").about).toBeNull();
  });

  test("a removed chip leaves its words in the title and its field empty", () => {
    expect(p("mañana 16:00 llamar", ["day"])).toMatchObject({
      title: "mañana llamar",
      dueOn: "2026-10-16",
      dueHm: "16:00",
    });
    expect(p("llamar mañana", ["day"])).toMatchObject({ title: "llamar mañana", dueOn: null });
  });

  test("chips name what was found, in words", () => {
    expect(p("mañana a las 4 ABC-1 !").chips).toEqual([
      { kind: "day", label: "mañana" },
      { kind: "time", label: "16:00" },
      { kind: "priority", label: "prioridad" },
      { kind: "about", label: "ABC-1" },
    ]);
    expect(p("el lunes").chips[0]?.label).toBe("lun 19 oct");
  });
});
