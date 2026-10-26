import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AiRows, engineText } from "./ai-section.tsx";
import { type Ai, type AiState, readAi } from "./queries.ts";

const state = (over: Partial<AiState> = {}): AiState => ({
  state: "off",
  gameMode: false,
  inFlight: 0,
  idleMinutes: 15,
  detail: null,
  ...over,
});
const text = (html: string) => html.replace(/<[^>]+>/g, "");

describe("local AI", () => {
  test("a machine that runs the engine is asked directly", async () => {
    const asked: string[] = [];
    const ai = await readAi(async (url) => {
      asked.push(url);
      return { configured: true, ...state({ state: "ready" }) };
    });
    expect(asked).toEqual(["/api/ai"]);
    expect(ai).toMatchObject({ base: "/api/ai", machine: null, state: { state: "ready" } });
  });

  test("a hub follows the worker it names; with none, there is no local AI", async () => {
    const asked: string[] = [];
    const ai = await readAi(async (url) => {
      asked.push(url);
      return url === "/api/ai"
        ? { configured: false, machine: "win" }
        : { configured: true, ...state() };
    });
    expect(asked).toEqual(["/api/ai", "/api/machines/win/ai"]);
    expect(ai).toMatchObject({ base: "/api/machines/win/ai", machine: "win" });
    expect(await readAi(async () => ({ configured: false, machine: null }))).toBeNull();
  });

  test("a worker that cannot be read is an error, never 'no local AI'", async () => {
    const failed = await readAi(async (url) => {
      if (url === "/api/ai") return { configured: false, machine: "win" };
      throw new Error("502 worker_unreachable");
    }).catch((e: Error) => e.message);
    expect(failed).toBe("502 worker_unreachable");
  });

  test("the row names the state, the queue, game mode and where it runs", () => {
    expect(engineText(state({ state: "ready", inFlight: 2 }))).toBe("Trabajando (2 en curso)");
    expect(engineText(state({ gameMode: true }))).toBe("Modo juego: no arranca");
    const row = (ai: Ai) =>
      text(
        renderToStaticMarkup(<AiRows ai={ai} pending={false} error={null} onAction={() => {}} />),
      );
    const off = row({ base: "/api/machines/win/ai", machine: "win", state: state() });
    expect(off).toContain("Corre en win. Se apaga tras 15 min sin uso.");
    expect(off).toContain("Encender");
    const failed = row({
      base: "/api/ai",
      machine: null,
      state: state({ state: "failed", detail: "el motor terminó con código 3" }),
    });
    expect(failed).toContain("Ha fallado");
    expect(failed).toContain("el motor terminó con código 3");
    expect(row({ base: "/api/ai", machine: null, state: state({ state: "ready" }) })).toContain(
      "Apagar",
    );
  });
});
