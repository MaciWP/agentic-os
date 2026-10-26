import { describe, expect, test } from "bun:test";
import { renderWith } from "../../test-render.tsx";
import { clock, RecView } from "./tile.tsx";

const transcript = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  meetingId: null,
  status: "ready",
  speakers: null,
  error: null,
  createdAt: "2026-10-22T09:00:00.000Z",
  updatedAt: "2026-10-22T09:40:00.000Z",
  names: { "Speaker 1": "Pedro" },
  labels: ["me", "Speaker 1"],
  progress: { done: 4, total: 4 },
  warnings: [],
  segments: [
    { start: 3, end: 5, speaker: "me", text: "hola" },
    { start: 6, end: 9, speaker: "Pedro", text: "buenas" },
  ],
  markdown: "[00:00:03] me: hola",
  ...over,
});
const item = (over: Record<string, unknown>) => ({
  kind: "action",
  text: "pedir la validación",
  owner: "Pedro",
  dueOn: null,
  at: 125,
  id: "a1",
  decision: null,
  ...over,
});
const render = (t: unknown, proposals?: unknown) => {
  const data: [unknown[], unknown][] = [[["transcripts", "r1"], { transcript: t }]];
  if (proposals !== undefined)
    data.push([["transcripts", "r1", "proposals"], { proposals, reviewAt: null }]);
  return renderWith(<RecView recording="r1" />, data);
};

describe("RecView", () => {
  test("while recording it shows the progress, the warnings and a way to stop", async () => {
    const html = await render(
      transcript({
        status: "recording",
        progress: { done: 2, total: 3 },
        warnings: ["mic_silent"],
        segments: [{ start: 1, end: 2, speaker: "others", text: "se oye" }],
      }),
    );
    expect(html).toContain('data-harness="rec"');
    expect(html).toContain("Grabando");
    expect(html).toContain(">Parar</button>");
    expect(html).toContain("2 de 3 bloques de cinco minutos transcritos.");
    expect(html).toContain("El micro apenas recibe voz");
    expect(html).toContain("Otros");
    expect(html).not.toContain("Propuestas");
  });

  test("a ready one lists the proposals by kind, with the user's call on each", async () => {
    const html = await render(transcript(), {
      summary: "Se habló del despliegue.",
      items: [
        item({}),
        item({ kind: "decision", text: "Mergear mañana", id: "d1", owner: null }),
        item({
          kind: "memory",
          text: "Pedro no está",
          id: "m1",
          decision: { state: "accepted", at: "t" },
        }),
      ],
    });
    expect(html).toContain("Se habló del despliegue.");
    expect(html.indexOf("Acciones")).toBeLessThan(html.indexOf("Acuerdos"));
    expect(html).toContain("Pedro · min 02:05");
    expect(html).toContain("Aceptada: en la nota, Para recordar");
    expect(html.match(/>Aceptar<\/button>/g)).toHaveLength(2);
    expect(html).toContain('value="Pedro"');
    expect(html).toContain("Yo");
  });

  test("before the agent proposes it says where the agent works", async () => {
    const html = await render(transcript(), null);
    expect(html).toContain("Mesa «Reuniones» del bloque Sistema");
    expect(html).toContain("Revisar otra vez");
  });

  test("a failed recording says why", async () => {
    const html = await render(transcript({ status: "failed", error: "helper crashed" }));
    expect(html).toContain("helper crashed");
  });

  test("a tile id with no recording says so", async () => {
    const html = await renderWith(<RecView recording={null} />, []);
    expect(html).toContain("no dice de qué grabación es");
  });

  test("times read as minutes, hours only past the hour", () => {
    expect(clock(125)).toBe("02:05");
    expect(clock(3725)).toBe("01:02:05");
  });
});
