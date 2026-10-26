import { describe, expect, test } from "bun:test";
import { renderWith } from "../../test-render.tsx";
import { CheckBody, EnvsActions, NewEnvBody } from "./env.tsx";
import type { RemovePreview } from "./env-jobs.ts";
import { newEnvProblem } from "./env-new.tsx";
import { RemoveEnv, removeRequest } from "./env-remove.tsx";
import {
  porcelain,
  RemoveIntro,
  RemoveLastCall,
  RemoveLosses,
  Stepper,
} from "./env-remove-steps.tsx";
import { JobOutput } from "./job-output.tsx";
import { job, projects, summary, withJob } from "./test-fixtures.ts";

describe("newEnvProblem", () => {
  const ok = (key: string, name: string) => newEnvProblem(key, name, ["backend"], ["abc-1"]);

  test("a ticket key, a free name and a repo can start", () => {
    expect(ok("ABC-123", "abc-123")).toBeNull();
    expect(ok("ABC-123", "otro.nombre_2")).toBeNull();
  });

  test("names the missing or malformed ticket", () => {
    expect(ok("", "x")).toContain("Escribe la clave");
    expect(ok("FEATURE/ABC-1", "x")).toContain("no es una clave");
    expect(ok("ABC", "x")).toContain("no es una clave");
  });

  test("names a name the provider would refuse", () => {
    expect(ok("ABC-2", "")).toContain("Escribe un nombre");
    for (const name of ["con espacio", "-opcion", ".oculto", "a/b", "x".repeat(64)])
      expect(ok("ABC-2", name)).toContain("solo admite");
  });

  test("an env that exists and no repos are refused", () => {
    expect(ok("ABC-1", "abc-1")).toBe("Ya hay un entorno «abc-1».");
    expect(newEnvProblem("ABC-2", "abc-2", [], [])).toBe("Elige al menos un repo.");
  });
});

describe("JobOutput", () => {
  test("a finished job shows how long it took and what the provider wrote", async () => {
    const html = await renderWith(<JobOutput summary={summary()} />, [
      withJob(job({ output: "pulled backend\n" })),
    ]);
    expect(html).toContain('aria-label="Resultado: Actualizar env-a"');
    expect(html).toContain("terminado · 1:05");
    expect(html).toContain("pulled backend");
  });

  test("a failure says why; a long output says it shows only its end", async () => {
    const failed = { state: "failed", error: "exited with 3" } as const;
    const html = await renderWith(<JobOutput summary={summary(failed)} />, [
      withJob(job({ ...failed, output: "x", truncated: true })),
    ]);
    expect(html).toContain("falló: exited with 3");
    expect(html).toContain("sus últimos 256 KB");
  });

  test("a running job with nothing written yet says it waits", async () => {
    const running = { state: "running", endedAt: null } as const;
    const html = await renderWith(<JobOutput summary={summary(running)} />, [
      withJob(job(running)),
    ]);
    expect(html).toContain("en curso");
    expect(html).toContain("Esperando la primera línea");
  });
});

describe("removing an env", () => {
  const preview = (over: Partial<RemovePreview> = {}): RemovePreview => ({
    dirty: {},
    unpublished: {},
    recoverableOnly: false,
    warnings: [],
    fingerprint: "f".repeat(64),
    open: [],
    ...over,
  });
  const noop = () => {};

  test("the stepper marks the steps done, the current one and how many there are", async () => {
    const html = await renderWith(<Stepper steps={["intro", "losses", "last"]} current="losses" />);
    expect(html).toContain("Paso 2 de 3 · Lo que se pierde");
    expect(html).toContain('aria-current="step" aria-label="Paso 2: Lo que se pierde"');
    const clean = await renderWith(<Stepper steps={["intro", "last"]} current="last" />);
    expect(clean).toContain("Paso 2 de 2 · Último aviso");
  });

  test("step 1 says what goes and waits for the dry run before going on", async () => {
    const props = { name: "env-a", onRecheck: noop, onCancel: noop, onNext: noop };
    const checking = await renderWith(<RemoveIntro {...props} checking error={null} />);
    expect(checking).toContain(
      "Las ramas de git se quedan. Las terminales abiertas dentro del entorno se cierran al borrar.",
    );
    expect(checking).toContain("Comprobando qué se perdería");
    expect(checking).toMatch(/disabled=""[^>]*>Sí, continuar</);
    const failed = await renderWith(<RemoveIntro {...props} checking={false} error="boom" />);
    expect(failed).toContain("No se pudo comprobar: boom");
    expect(failed).toContain(">Volver a comprobar</button>");
  });

  test("step 2 lists every loss, commits first, and goes on only once reviewed", async () => {
    const files = Array.from({ length: 12 }, (_, i) => ` M src/f${i}.ts`);
    const html = await renderWith(
      <RemoveLosses
        preview={preview({
          unpublished: { contract: ["abc123 wip"] },
          dirty: { backend: ["?? reports/", ...files] },
        })}
        onBack={noop}
        onNext={noop}
      />,
    );
    expect(html).toContain("Hay 14 cambios pendientes");
    expect(html.indexOf("Commits que no están en ningún remoto")).toBeLessThan(
      html.indexOf("Cambios sin commit"),
    );
    // Every line, without a cut: the last place to see them.
    expect(html).toContain("src/f11.ts");
    expect(html).toContain("He revisado los 14 cambios que se pierden");
    expect(html).toMatch(/disabled=""[^>]*>Sí, continuar</);
  });

  test("step 3 is the last call: one box ticked, a red button that starts off", async () => {
    const props = { name: "env-a", pending: false, onBack: noop, onRecheck: noop, onRemove: noop };
    const lossy = preview({
      dirty: { backend: ["?? reports/"], contract: [" M package-lock.json"] },
    });
    const html = await renderWith(<RemoveLastCall {...props} preview={lossy} error={null} />);
    expect(html).toContain("Esto no se puede deshacer");
    expect(html).toContain("Se pierden 2 cambios en backend, contract.");
    expect(html).toContain(
      'Sí, borrar <span class="font-mono">env-a</span> y perder estos cambios',
    );
    expect(html).not.toContain('type="text"');
    expect(html).toMatch(/class="btn btn-danger[^"]*" disabled=""/);
    expect(html).not.toContain("terminal abierta");
    const clean = await renderWith(
      <RemoveLastCall
        {...props}
        preview={preview({ warnings: ["docker: not running"] })}
        error="lo pendiente ha cambiado"
      />,
    );
    expect(clean).toContain("No se pierde trabajo");
    expect(clean).toContain("docker: not running");
    expect(clean).toContain("lo pendiente ha cambiado");
    expect(clean).toContain(">Volver a revisar</button>");
  });

  test("step 3 names the open terminals the remove closes, without asking anything more", async () => {
    const props = { name: "env-a", pending: false, onBack: noop, onRecheck: noop, onRemove: noop };
    const open = [
      { id: "t1", name: "claude", folder: "env-a/backend" },
      { id: "t2", name: "shell", folder: "env-a" },
    ];
    const html = await renderWith(
      <RemoveLastCall {...props} preview={preview({ open })} error={null} />,
    );
    expect(html).toContain("Se cierran 2 terminales abiertas. Mira que no tengan nada a medias:");
    expect(html).toContain('«claude» en <span class="font-mono">env-a/backend</span>');
    expect(html.match(/type="checkbox"/g)).toHaveLength(1);
    const one = await renderWith(
      <RemoveLastCall {...props} preview={preview({ open: open.slice(0, 1) })} error={null} />,
    );
    expect(one).toContain("Se cierra 1 terminal abierta. Mira que no tenga nada a medias:");
  });

  test("the remove sends the fingerprint of the approved losses, and none when clean", () => {
    const approved = preview({ dirty: { backend: ["?? reports/"] }, fingerprint: "a".repeat(64) });
    expect(removeRequest("env-a", approved)).toEqual({
      action: "remove",
      name: "env-a",
      confirm: "env-a",
      seen: "a".repeat(64),
    });
    expect(removeRequest("env-a", preview())).not.toHaveProperty("seen");
  });

  test("the remove closes only the open terminals the user saw listed", () => {
    const open = [{ id: "t1", name: "claude", folder: "env-a/backend" }];
    expect(removeRequest("env-a", preview({ open }))).toMatchObject({ close: ["t1"] });
    expect(removeRequest("env-a", preview())).not.toHaveProperty("close");
  });

  test("porcelain lines read as a word and a path", () => {
    expect(porcelain("?? reports/")).toEqual({ word: "nuevo", path: "reports/" });
    expect(porcelain(" M package-lock.json")).toEqual({
      word: "modificado",
      path: "package-lock.json",
    });
    expect(porcelain("D  old.ts")).toEqual({ word: "borrado", path: "old.ts" });
    expect(porcelain("contract:  M openapi.yaml")).toEqual({
      word: "modificado",
      path: "contract/openapi.yaml",
    });
    expect(porcelain("something else")).toEqual({ word: null, path: "something else" });
  });
});

describe("env panes", () => {
  test("«Borrar entorno…» waits while the env is busy and opens no modal by itself", async () => {
    const busy = await renderWith(<RemoveEnv name="env-a" busy />);
    expect(busy).toMatch(/disabled=""[^>]*aria-label="Borrar entorno…"/);
    const idle = await renderWith(<RemoveEnv name="env-a" busy={false} />);
    expect(idle).toContain('aria-label="Borrar entorno…"');
    expect(idle).not.toMatch(/disabled=""[^>]*aria-label="Borrar entorno…"/);
    expect(idle).not.toContain("<dialog");
  });

  const created = summary({ id: "c1", action: "create", env: "abc-9" });
  const status: [unknown[], unknown] = [
    ["envjobs", "status"],
    {
      configured: true,
      shared: { value: { running: 3, envs: ["env-a"], ports: {} }, error: null },
      proxy: { value: null, error: "proxy status exited with 4: boom" },
    },
  ];
  const idle = { pending: false, error: null, start: async () => true };

  test("the Entornos buttons: a create running shows on «Nuevo», and no modal opens by itself", async () => {
    const html = await renderWith(<EnvsActions envs={projects().envs} />, [
      [["envjobs"], { jobs: [{ ...created, state: "running", endedAt: null }] }],
    ]);
    expect(html).toContain('aria-label="Nuevo entorno (se está creando uno)"');
    expect(html).toContain('aria-label="Diagnóstico"');
    expect(html).not.toContain("<dialog");
  });

  test("Nuevo entorno: the form, every repo, and the new env's progress", async () => {
    const html = await renderWith(<NewEnvBody envs={projects().envs} jobs={idle} />, [
      [["envjobs"], { jobs: [created] }],
      withJob(job({ ...created, output: "cloning backend" })),
    ]);
    expect(html).toContain('aria-label="Nuevo entorno"');
    expect(html).toContain(">backend</span>");
    expect(html).toMatch(/disabled=""[^>]*>Crear entorno</);
    expect(html).toContain("cloning backend");
  });

  test("Diagnóstico: every status and the check-up", async () => {
    const html = await renderWith(<CheckBody envs={projects().envs} check={idle} />, [
      [["envjobs"], { jobs: [created] }],
      status,
    ]);
    expect(html).toContain("3 en marcha");
    expect(html).toContain("los usan env-a");
    expect(html).toContain("proxy status exited with 4: boom");
    expect(html).toContain('<span class="font-mono">env-a</span>');
    expect(html).toContain(">Revisar</button>");
    expect(html).not.toContain('aria-label="Resultado: Diagnóstico"');
    // The create's progress belongs to «Nuevo entorno».
    expect(html).not.toContain("abc-9");
  });
});
