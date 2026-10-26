import { expect, test } from "bun:test";
import type { JudgeRun } from "../../../server/features/usage/judge.ts";
import { renderWith } from "../../test-render.tsx";
import { AdvisorFit, Dictation, EffortFit, JudgeNote, LevelSignals } from "./judge.tsx";
import { judge, pose } from "./test-fixtures.ts";

const LAST: JudgeRun = {
  id: "r1",
  from: "2026-10-12T22:00:00.000Z",
  to: "2026-10-19T22:00:00.000Z",
  trigger: "auto",
  state: "capped",
  turns: 40,
  judged: 30,
  unmatched: 2,
  usd: 5,
  error: null,
  startedAt: "2026-10-20T08:00:00.000Z",
  finishedAt: "2026-10-20T08:10:00.000Z",
};

const JUDGED = judge({
  judged: 10,
  effort: { chosen: { under: 2, ok: 7, over: 1 }, applied: { under: 0, ok: 5, over: 5 } },
  byChosen: [
    { effort: "medium", under: 2, ok: 4, over: 0 },
    { effort: "high", under: 0, ok: 3, over: 1 },
  ],
  gauge: { under: 1, ok: 6, over: 1 },
  fixes: {
    ok: 2,
    wrong: 1,
    missed: 3,
    missedTop: [
      { word: "pose", count: 2 },
      { word: "zot", count: 1 },
    ],
  },
  worst: [
    {
      at: "2026-10-20T09:00:00.000Z",
      chosen: "medium",
      applied: "high",
      judged: "xhigh",
      why: "Una migración con datos reales.",
      prompt: "migra la tabla de",
    },
  ],
  last: LAST,
});

test("effort: a bar per level the mod chose, the level that ran, and the furthest turns", async () => {
  const html = await renderWith(<EffortFit j={JUDGED} floor="high" />);
  expect(html).toContain("4 de 6 · 66,7");
  expect(html).toContain("3 de 4 · 75");
  expect(html).toContain('title="medium · le falta: 2 de 6"');
  expect(html).toMatch(/Con tu nivel fijado \(high\), el nivel(<!-- -->)? que corrió acierta/);
  expect(html).toMatch(/le sobra en(<!-- -->)? (<!-- -->)?5/);
  expect(html).toContain("El turno más lejos del juez");
  expect(html).toContain("mod medium · corrió high · juez xhigh");
  expect(html).toContain("«migra la tabla de»");
  expect(await renderWith(<EffortFit j={judge()} floor={null} />)).toContain(
    "Sin veredictos del juez en este periodo.",
  );
});

test("the judge's note: the last pass, cut at the cap, and the button", async () => {
  const html = await renderWith(<JudgeNote j={JUDGED} />);
  expect(html).toContain("10 de 14 turnos de este periodo tienen veredicto");
  expect(html).toContain("Cada lunes juzga solo la semana anterior");
  expect(html).toContain("(automática)");
  expect(html).toContain("30 de 40 turnos, 5,00 $");
  expect(html).toContain("Se cortó al llegar al tope de 5 $.");
  expect(html).toContain("2 turnos sin juzgar");
  expect(html).toMatch(/<button[^>]*>Repetir · ≈0,08 \$<\/button>/);
  // While a pass runs, and on a server that cannot call Claude, the button is off.
  const running = await renderWith(<JudgeNote j={judge({ running: true })} />);
  expect(running).toMatch(/<button[^>]*disabled=""[^>]*>Juzgando…<\/button>/);
  const off = await renderWith(<JudgeNote j={judge({ available: false, auto: false })} />);
  expect(off).toMatch(/<button[^>]*disabled=""[^>]*title="Este servidor no puede llamar a Claude"/);
  expect(off).toContain("La pasada de los lunes está apagada");
  const failed = await renderWith(
    <JudgeNote j={judge({ last: { ...LAST, state: "failed", error: "boom" } })} />,
  );
  expect(failed).toContain('role="alert"');
  expect(failed).toContain("Falló: boom.");
});

test("the advisor: as asked per gauge, a dash where a gauge cannot miss, and the judge's gauge", async () => {
  const html = await renderWith(<AdvisorFit r={pose()} j={JUDGED} />);
  expect(html).toContain("antes del plan, al atascarse y antes de acabar");
  expect(html).toContain("7 · 87,5");
  // Gauge 0 cannot fall short and gauge 3 cannot go over.
  const cells = [...html.matchAll(/<tr[^>]*>(.*?)<\/tr>/g)].slice(1).map((m) => m[1] ?? "");
  expect(cells[0]).toMatch(/>—<\/td><td[^>]*>1<\/td>/);
  expect(cells[1]).toMatch(/>3<\/td><td[^>]*>—<\/td>/);
  expect(html).toContain("0,40 $");
  expect(html).toContain("El juez pondría el mismo medidor en 6 de 8 turnos");
});

test("dictation: the pairs, the judge's verdict on them and what stayed misheard", async () => {
  const html = await renderWith(<Dictation r={pose()} j={JUDGED} />);
  expect(html).toContain("3 arreglos en 2 de 12 prompts clasificados");
  expect(html).toContain("biom → Biome");
  expect(html).toContain("×2");
  expect(html).toContain("El juez da por buenos 2 de 3 arreglos.");
  expect(html).toContain("Se quedaron sin arreglar 3 palabras: pose ×2, zot.");
  const none = await renderWith(
    <Dictation
      r={pose({ dictation: { prompts: 0, total: 0, logged: 0, pairs: [] } })}
      j={judge()}
    />,
  );
  expect(none).toContain("el mod los guarda desde su versión 0.3.2");
});

test("leads per level, with the rules that make them", async () => {
  const html = await renderWith(<LevelSignals r={pose()} />);
  expect(html).toContain("0,30 $");
  expect(html).toContain("low o medium con 20 pasos o más");
  expect(html).toContain("high o más con 2 pasos o menos y 1 herramienta como mucho");
});
