import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { failQuery, renderWith } from "../../test-render.tsx";
import type { RendererState } from "../terminals/renderer.ts";
import { terminal } from "../terminals/test-fixtures.ts";
import { SystemIndicator, SystemPanel } from "./indicator.tsx";
import { PLAN_STALE_MS, totals, windowName } from "./plan-text.ts";
import { newServerUp, type Plans, type PlanUsage, type SystemSnapshot } from "./queries.ts";
import { RestartDialog, restartLosses } from "./restart-dialog.tsx";
import { SystemLine } from "./system-line.tsx";

const NOW = Date.parse("2026-10-06T14:00:00Z");

const claude = (): PlanUsage => ({
  windows: [
    { minutes: 300, percent: 8, resetAt: "2026-10-06T17:30:00+00:00" },
    { minutes: 10_080, percent: 29, resetAt: "2026-10-09T18:00:00+00:00" },
  ],
  updatedAt: new Date(NOW - 60_000).toISOString(),
});
const codex = (): PlanUsage => ({
  windows: [{ minutes: 10_080, percent: 13, resetAt: "2026-10-12T11:03:41.000Z" }],
  updatedAt: new Date(NOW - 120_000).toISOString(),
});
const plans = (over: Partial<Plans> = {}): Plans => ({
  claude: claude(),
  codex: codex(),
  grok: { error: "no_source" },
  ...over,
});

const snap = (over: Partial<SystemSnapshot> = {}): SystemSnapshot => ({
  app: {
    server: { cpu: 2.5, rssKb: 200 * 1024 },
    host: { cpu: 1, rssKb: 100 * 1024 },
    hostStale: false,
  },
  terminals: [
    { id: "a", cpu: 30, rssKb: 400 * 1024 },
    { id: "b", cpu: null, rssKb: null },
  ],
  awake: { held: true, since: "2026-10-06T13:00:00Z", screen: null },
  plans: plans(),
  ...over,
});

const text = (html: string) => html.replace(/<[^>]+>/g, "");

describe("system indicator", () => {
  test("totals add the app and every terminal, skipping what ps did not find", () => {
    expect(totals(snap())).toEqual({ cpu: 33.5, rssKb: 700 * 1024 });
  });

  test("the line shows each harness's logo with its use and the awake mark, and spells out the rest", () => {
    const html = renderToStaticMarkup(<SystemLine s={snap()} now={NOW} />);
    expect(text(html)).toBe("29%13%");
    expect(html).toContain('data-harness="claude"');
    expect(html).toContain('data-harness="codex"');
    expect(html).toContain('data-harness="grok"');
    expect(html).toContain(
      'title="2 term. en marcha · 33,5 % CPU · 700 MB · Claude 8 % · 29 % · Codex 13 % · Grok sin dato"',
    );
    expect(html).toContain('title="El Mac se mantiene despierto"');
    expect(html).not.toContain("text-warn");
  });

  test("a stale or missing subscription reading is flagged, never shown as zero", () => {
    const old = codex();
    if (!("error" in old)) old.updatedAt = new Date(NOW - PLAN_STALE_MS - 1).toISOString();
    expect(
      renderToStaticMarkup(<SystemLine s={snap({ plans: plans({ codex: old }) })} now={NOW} />),
    ).toContain("text-warn");
    const none = renderToStaticMarkup(
      <SystemLine s={snap({ plans: plans({ claude: { error: "no_source" } }) })} now={NOW} />,
    );
    expect(text(none)).toBe("—13%");
    expect(none).toContain("Claude sin dato");
    expect(none).toContain("text-warn");
  });

  test("Grok's missing source is muted, not a warning that never clears", () => {
    expect(renderToStaticMarkup(<SystemLine s={snap()} now={NOW} />)).not.toContain("text-warn");
  });

  test("a reading from before a window renewed shows no number for that window", () => {
    const late = NOW + 4 * 3_600_000;
    const line = text(renderToStaticMarkup(<SystemLine s={snap()} now={late} />));
    expect(line).toBe("29%13%");
    const panel = text(
      renderToStaticMarkup(<SystemPanel s={snap()} list={[]} now={late} onOpen={() => {}} />),
    );
    expect(panel).toContain("Sesión (5 h)renovada · aún sin dato nuevo");
    expect(panel).toMatch(/Semana29 % · se renueva el vie/);
    const week = text(
      renderToStaticMarkup(<SystemLine s={snap()} now={Date.parse("2026-10-10T00:00:00Z")} />),
    );
    expect(week).toBe("—13%");
  });

  test("the panel names each running terminal and explains the missing subscription source", () => {
    const html = renderToStaticMarkup(
      <SystemPanel
        s={snap({
          plans: plans({ claude: { error: "no_source" } }),
          awake: { held: false, since: null, screen: null },
        })}
        list={[terminal({ id: "a", name: "api fix" })]}
        now={NOW}
        onOpen={() => {}}
      />,
    );
    const t = text(html);
    expect(t).toContain("Servidor2,5 % CPU · 200 MB");
    expect(t).toContain("Terminales en marcha (2)");
    expect(t).toContain("api fix30 % CPU · 400 MB");
    expect(t).toContain("bno encontrado");
    expect(t).toContain("Sin dato: abre una sesión de Claude");
    expect(t).toContain("Sin dato: Grok no guarda sus límites en local");
    expect(t).toContain("Libre: no hay terminales en marcha.");
  });

  test("the panel gives each limit its reset and how fresh the reading is", () => {
    const t = text(
      renderToStaticMarkup(<SystemPanel s={snap()} list={[]} now={NOW} onOpen={() => {}} />),
    );
    expect(t).toMatch(/Sesión \(5 h\)8 % · se renueva a las \d\d:30/);
    expect(t).toMatch(/Semana29 % · se renueva el vie, \d\d:00/);
    expect(t).toContain("Actualizado hace 1 min");
    expect(t).toMatch(
      /Suscripción de CodexSemana13 % · se renueva el lun, \d\d:03Actualizado hace 2 min/,
    );
    expect(t).toContain("El Mac no se dormirá");
    expect(t).not.toContain("código antiguo");
  });

  test("a host kept from older code says why new terminals still get its flags", () => {
    const s = snap();
    s.app.hostStale = true;
    const t = text(
      renderToStaticMarkup(<SystemPanel s={s} list={[]} now={NOW} onOpen={() => {}} />),
    );
    expect(t).toContain("El PTY host ejecuta código antiguo");
    expect(renderToStaticMarkup(<SystemLine s={s} now={NOW} />)).toContain(
      "PTY host con código antiguo",
    );
  });

  test("a failed poll keeps the last reading, dimmed, with the reason on hover", async () => {
    const indicator = (data?: unknown) =>
      renderWith(<SystemIndicator />, [], failQuery(["system"], data, "ps failed"));
    const kept = await indicator(snap());
    expect(kept).toContain('title="Sin actualizar: ps failed"');
    expect(kept).toContain("opacity-50");
    expect(await indicator()).toContain("Sistema no disponible");
  });

  test("a window is named by its length", () => {
    expect([300, 10_080, 2880, 120, 45].map(windowName)).toEqual([
      "Sesión (5 h)",
      "Semana",
      "2 d",
      "2 h",
      "45 min",
    ]);
  });

  test("the screen switch offers its times, says until when it holds, and the line shows it", () => {
    const off = text(
      renderToStaticMarkup(<SystemPanel s={snap()} list={[]} now={NOW} onOpen={() => {}} />),
    );
    expect(off).toContain("No bloquear la pantalla");
    expect(off).toContain("La pantalla se bloquea sola");
    for (const label of ["1 h", "2 h", "4 h", "Sin límite"]) expect(off).toContain(label);
    expect(off).not.toContain("Quitar");

    const until = "2026-10-07T12:30:00Z";
    const held = snap({ awake: { held: true, since: null, screen: { until, auto: false } } });
    const on = text(
      renderToStaticMarkup(<SystemPanel s={held} list={[]} now={NOW} onOpen={() => {}} />),
    );
    const hhmm = new Date(until).toLocaleTimeString("es-ES", {
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(on).toContain(`Activo hasta las ${hhmm}.`);
    expect(on).toContain("Quitar");
    expect(renderToStaticMarkup(<SystemLine s={held} now={NOW} />)).toContain(
      'title="La pantalla no se bloquea"',
    );

    // Held by the config while agents work: nothing to take off by hand.
    const auto = snap({ awake: { held: true, since: null, screen: { until: null, auto: true } } });
    const a = text(
      renderToStaticMarkup(<SystemPanel s={auto} list={[]} now={NOW} onOpen={() => {}} />),
    );
    expect(a).toContain("Activo mientras trabaja algún agente.");
    expect(a).not.toContain("Quitar");
  });

  test("system notifications: a button to ask, or what the browser decided", () => {
    const panel = (permission: "default" | "granted" | "denied") =>
      text(
        renderToStaticMarkup(
          <SystemPanel
            s={snap()}
            list={[]}
            now={NOW}
            onOpen={() => {}}
            desktop={{ permission, onAsk: () => {} }}
          />,
        ),
      );
    expect(panel("default")).toContain("Activar avisos del sistema");
    expect(panel("granted")).toContain("macOS te avisa cuando la app no está delante");
    expect(panel("denied")).toContain("Ajustes del Sistema → Notificaciones → Google Chrome");
  });

  test("terminal drawing: three choices, the pressed one and who draws now", () => {
    const panel = (state: RendererState) =>
      renderToStaticMarkup(
        <SystemPanel
          s={snap()}
          list={[]}
          now={NOW}
          onOpen={() => {}}
          renderer={{ state, onChoose: () => {} }}
        />,
      );
    const m3 = "ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)";
    const gpu = panel({ choice: "auto", gpuName: m3, onGpu: 6, total: 6 });
    expect(gpu).toMatch(/aria-pressed="true"[^>]*>Automático/);
    expect(gpu).toMatch(/aria-pressed="false"[^>]*>GPU forzada/);
    expect(gpu).toMatch(/aria-pressed="false"[^>]*>CPU/);
    expect(text(gpu)).toContain("Ahora: GPU en 6 de 6 terminales.");
    expect(text(gpu)).toContain(`GPU: ${m3}`);
    const cpu = text(panel({ choice: "dom", gpuName: m3, onGpu: 0, total: 1 }));
    expect(cpu).toContain("Ahora: CPU en 1 terminal.");
    const soft = "SwiftShader Device";
    expect(text(panel({ choice: "auto", gpuName: soft, onGpu: 0, total: 2 }))).toContain(
      "Automático dibuja con la CPU",
    );
    expect(text(panel({ choice: "gpu", gpuName: soft, onGpu: 2, total: 2 }))).toContain(
      "puede gastar varios núcleos",
    );
    expect(text(panel({ choice: "auto", gpuName: null, onGpu: 0, total: 0 }))).toContain(
      "no tiene WebGL2",
    );
  });

  test("«Reiniciar…» sits in the App section, with what a full restart costs in its dialog", async () => {
    const panel = text(
      renderToStaticMarkup(<SystemPanel s={snap()} list={[]} now={NOW} onOpen={() => {}} />),
    );
    expect(panel).toContain("Reiniciar…");
    const list = [
      terminal({ id: "a", harness: "claude" }),
      terminal({ id: "b", harness: "shell" }),
      terminal({ id: "c", harness: "codex" }),
      terminal({ id: "d", harness: "env", action: "start" }),
      terminal({ id: "e", harness: "grok", state: "exited" }),
    ];
    expect(restartLosses(list)).toEqual({ closed: 2, resumed: 2 });
    const dialog = (hostStale: boolean) =>
      renderWith(<RestartDialog list={list} hostStale={hostStale} onClose={() => {}} />);
    const html = text(await dialog(false));
    expect(html).toContain("Se cierran 2 shells o comandos de entorno.");
    expect(html).toContain("2 agentes se reanudan con su sesión");
    expect(html).not.toContain("código antiguo");
    expect(text(await dialog(true))).toContain("solo «Reiniciar todo» lo actualiza");
    const idle = text(
      await renderWith(<RestartDialog list={[]} hostStale={false} onClose={() => {}} />),
    );
    expect(idle).toContain("No hay terminales en marcha.");
    // Unread is not none: a restart confirmed on "no terminals" may close real ones.
    const unread = (listError?: string) =>
      renderWith(
        <RestartDialog
          list={undefined}
          listError={listError}
          hostStale={false}
          onClose={() => {}}
        />,
      );
    const loading = text(await unread());
    expect(loading).not.toContain("No hay terminales");
    expect(loading).toContain("Leyendo qué terminales hay en marcha…");
    const failed = text(await unread("timed out"));
    expect(failed).not.toContain("No hay terminales");
    expect(failed).toContain("No se pudo leer qué terminales hay en marcha: timed out.");
  });

  test("the page waits through a down server and an ingress 502 for a server with another pid", async () => {
    let t = 0;
    const answers: (Response | Error)[] = [
      new Error("connection refused"),
      new Response("bad gateway", { status: 502 }),
      Response.json({ ok: true, pid: 7 }),
      Response.json({ ok: true, pid: 8 }),
    ];
    const get = async () => {
      const next = answers.shift() ?? Response.json({ ok: true, pid: 8 });
      if (next instanceof Error) throw next;
      return next;
    };
    const clock = {
      get,
      sleep: async (ms: number) => {
        t += ms;
      },
      now: () => t,
    };
    expect(await newServerUp(7, clock)).toBe(true);
    expect(t).toBe(4000);
    // The old server still answering past the limit: the page says so instead of waiting.
    t = 0;
    const stuck = { ...clock, get: async () => Response.json({ ok: true, pid: 7 }) };
    expect(await newServerUp(7, stuck, 5000)).toBe(false);
  });
});
