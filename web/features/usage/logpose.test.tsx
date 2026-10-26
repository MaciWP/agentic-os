import { expect, test } from "bun:test";
import { renderWith } from "../../test-render.tsx";
import { compareOf, LogPose } from "./logpose.tsx";
import { view } from "./test-fixtures.ts";

test("hook against Log Pose: each row better or worse by its own direction", () => {
  const rows = Object.fromEntries(compareOf(view()).map((r) => [r.name, [r.before, r.after]]));
  expect(rows["Latencia (mediana)"]).toEqual([5000, 1800]);
  expect(rows["Acierto de skills"]).toEqual([0.3, 0.5]);
  expect(rows["Se le escapan"]).toEqual([0.3, 0.4]);
  expect(rows["Sin respuesta o error"]).toEqual([0.05, 0]);
  // Each by its own rule: the hook's notes with a tool call after them, the mod's answers.
  expect(rows["Llega a tiempo"]).toEqual([0.9, 1]);
  // The mod's cost comes from its tokens: 0,0312 $ over 12 prompts.
  expect(rows["Coste por prompt"]).toEqual([0.002, 0.0026]);
  // Calls with no level stay out of the share at high or more.
  expect(rows["Llamadas en high o más"]).toEqual([0.75, 0.1]);
});

test("the view: deltas marked better or worse, targets, the balance and a small-sample warning", async () => {
  const html = await renderWith(<LogPose v={view()} />, []);
  expect(html).toContain("Muestra pequeña");
  expect(html).toContain("12 prompts clasificados");
  // Faster and a better hit are wins; more misses and a dearer prompt are losses.
  expect(html).toMatch(/mejor<\/span>(<!-- -->)?−(<!-- -->)?3,2\ss/);
  expect(html).toMatch(/mejor<\/span>(<!-- -->)?\+(<!-- -->)?20 pp/);
  expect(html).toMatch(/peor<\/span>(<!-- -->)?\+(<!-- -->)?10 pp/);
  // Fewer calls at high is a change to read, with no verdict of its own.
  expect(html).toMatch(/<td[^>]*>(<span[^>]*>)?−(<!-- -->)?65 pp/);
  // The mod is on time by construction: no target of its own, its failures go elsewhere.
  expect(html).toMatch(/Llega a tiempo.*?por construcción/s);
  expect(html).not.toMatch(/Llega a tiempo[^<]*<[^>]*>[^<]*objetivo/);
  // 7 at gauge 0 and 1 at gauge 3 called the advisor as asked: 8 of 12, to watch.
  expect(html).toMatch(/Medidor cumplido.*?66,7.*?vigilar/s);
  expect(html).toMatch(/8 de 12<\/dt><dd[^>]*>turnos que llamaron al advisor/);
  // No pass of the judge yet: its figures say so, and the button says its price.
  expect(html).toMatch(/Acierto del effort.*?sin veredictos del juez/s);
  expect(html).toContain("0 de 14 turnos de este periodo tienen veredicto");
  expect(html).toMatch(/Juzgar este periodo · ≈0,08 \$/);
  expect(html).toContain("falta una pasada del juez");
  // The floor is the user's: told apart, neither hit nor miss.
  expect(html).toContain("Tu nivel fijado (high) subió 4 de 12 prompts");
  // Cache breaks moved to Salud.
  expect(html).not.toContain("Roturas de caché");
  // The balance: 11 prompts at low or medium, 3 at high.
  expect(html).toMatch(/11<\/dt><dd[^>]*>prompts en low o medium/);
  expect(html).toMatch(/3<\/dt><dd[^>]*>prompts en high o más/);
  expect(html).toContain("needs design");
  expect(html).toContain('aria-label="Niveles por dificultad"');
  expect(html).toContain("continuación");
});

test("enough prompts drop the warning; no mod run at all says the hook still reads them", async () => {
  expect(await renderWith(<LogPose v={view({ classified: 40 })} />, [])).not.toContain(
    "Muestra pequeña",
  );
  expect(await renderWith(<LogPose v={null} />, [])).toContain("el router sigue con el hook");
});
