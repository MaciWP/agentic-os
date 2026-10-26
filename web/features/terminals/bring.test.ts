import { describe, expect, test } from "bun:test";
import { ApiError } from "../../api.ts";
import { memoryStorage } from "../../test-storage.ts";
import {
  bringBlocked,
  bringErrorText,
  bringLabel,
  bringMode,
  decodeBring,
  encodeBring,
  imagesIn,
  pasteProblem,
  reportTarget,
  uploadImage,
  withMode,
} from "./bring.ts";
import { terminal } from "./test-fixtures.ts";

describe("bring", () => {
  test("an item survives the drag, and only an item this app wrote comes out of a drop", () => {
    const ticket = { ticket: "ABC-101" };
    const pr = { pr: { repo: "api", number: 7 } };
    expect(decodeBring(encodeBring(ticket))).toEqual(ticket);
    for (const task of ["work", "review"] as const)
      expect(decodeBring(encodeBring({ ticket: "ABC-101", task }))).toEqual({
        ticket: "ABC-101",
        task,
      });
    expect(decodeBring(encodeBring(pr))).toEqual(pr);
    expect(decodeBring(encodeBring({ ...pr, task: "review" }))).toEqual({ ...pr, task: "review" });
    const images = {
      images: ["pasted:a.png", "captured:b.png", "folder:Captura 10.00.00\u202fp. m. #2.png"],
    };
    expect(decodeBring(encodeBring(images))).toEqual(images);
    for (const raw of [
      "ABC-101",
      "null",
      "[]",
      '"ABC-101"',
      '{"ticket":"abc-101; rm -rf ~"}',
      '{"ticket":"ABC-101","pr":{"repo":"api","number":7}}',
      '{"pr":{"repo":"","number":7}}',
      '{"pr":{"repo":"api","number":0}}',
      '{"pr":{"repo":"api","number":1.5}}',
      '{"pr":{"repo":"api","number":"7"}}',
      '{"pr":null}',
      '{"text":"rm -rf ~"}',
      '{"ticket":"ABC-101","intent":"review"}',
      '{"ticket":"ABC-101","task":"merge"}',
      '{"ticket":"ABC-101","task":null}',
      '{"ticket":"ABC-101","task":"review","text":"extra"}',
      '{"task":"review"}',
      '{"pr":{"repo":"api","number":7},"task":"work"}',
      '{"images":["pasted:a.png"],"task":"review"}',
      '{"images":[]}',
      '{"images":["/etc/passwd"]}',
      '{"images":["folder:../x.png"]}',
      '{"images":["folder:a\\\\b.png"]}',
      '{"images":["nope:x.png"]}',
      '{"images":[1]}',
      '{"images":"pasted:a.png"}',
      `{"images":${JSON.stringify(Array(6).fill("pasted:a.png"))}}`,
    ])
      expect([raw, decodeBring(raw)]).toEqual([raw, null]);
  });

  test("the mode adds the task, Trabajar for mine and Revisar for the rest, or takes it away", () => {
    const pr = { pr: { repo: "api", number: 7 } };
    expect(withMode({ ticket: "ABC-1" }, "content")).toEqual({ ticket: "ABC-1" });
    expect(withMode({ ticket: "ABC-1", task: "work" }, "content")).toEqual({ ticket: "ABC-1" });
    expect(withMode({ ticket: "ABC-1" }, "task")).toEqual({ ticket: "ABC-1", task: "work" });
    expect(withMode({ ticket: "ABC-1" }, "task", false)).toEqual({
      ticket: "ABC-1",
      task: "review",
    });
    expect(withMode(pr, "content")).toEqual(pr);
    expect(withMode(pr, "task")).toEqual({ ...pr, task: "review" });
    const images = { images: ["pasted:a.png"] };
    expect(withMode(images, "task")).toBe(images);
  });

  test("labels name the ticket or the PR", () => {
    expect(bringLabel({ ticket: "ABC-101" })).toBe("ABC-101");
    expect(bringLabel({ pr: { repo: "api", number: 7 } })).toBe("api#7");
    expect(bringLabel({ images: ["pasted:a.png"] })).toBe("1 imagen");
    expect(bringLabel({ images: ["pasted:a.png", "folder:b.png"] })).toBe("2 imágenes");
  });

  test("a running shell or agent takes it; env commands, ended and gone terminals do not", () => {
    expect(bringBlocked(terminal({ harness: "shell" }))).toBeNull();
    expect(bringBlocked(terminal({ harness: "claude" }))).toBeNull();
    expect(bringBlocked(terminal({ harness: "env" }))).toBe(
      "un comando de entorno no recibe texto",
    );
    // An ended env command still says what it is, not that it ended.
    expect(bringBlocked(terminal({ harness: "env", state: "exited" }))).toBe(
      "un comando de entorno no recibe texto",
    );
    expect(bringBlocked(terminal({ state: "exited" }))).toBe("la terminal no está en marcha");
    expect(bringBlocked(terminal({ state: "failed" }))).toBe("la terminal no está en marcha");
    expect(bringBlocked(undefined)).toBe("la terminal ya no existe");
  });

  test("a bar prompt survives the drag, keeps its mode and names its file", () => {
    const item = { prompt: "prompts:Revisar ticket.md" };
    expect(decodeBring(encodeBring(item))).toEqual(item);
    expect(withMode(item, "task")).toEqual(item);
    expect(bringLabel(item)).toBe("«Revisar ticket»");
    for (const bad of [{ prompt: "" }, { prompt: 1 }, { prompt: "p", task: "work" }])
      expect(decodeBring(JSON.stringify(bad))).toBeNull();
  });

  test("a bar prompt needs Claude or Codex waiting for its next message", () => {
    const idle = { sessionId: "s", state: "needs_you" as const };
    expect(bringBlocked(terminal({ harness: "claude", agent: idle }), true)).toBeNull();
    expect(
      bringBlocked(terminal({ harness: "claude", agent: { ...idle, state: "working" } }), true),
    ).toBe("el agente está trabajando");
    expect(bringBlocked(terminal({ harness: "grok", agent: null }), true)).toBe(
      "no se sabe si este agente está libre",
    );
    expect(bringBlocked(terminal({ harness: "shell" }), true)).toBe(
      "solo un agente Claude o Codex recibe botones",
    );
    // The usual checks come first.
    expect(bringBlocked(terminal({ harness: "claude", state: "exited" }), true)).toBe(
      "la terminal no está en marcha",
    );
    expect(bringErrorText(new ApiError(409, "missing", "{{ticket}}"))).toBe(
      "a esta terminal le falta {{ticket}}",
    );
  });

  test("the server's refusals read as sentences; a rejected PR keeps the server's reason", () => {
    expect(bringErrorText(new ApiError(409, "no_paste", ""))).toContain("aún no acepta texto");
    expect(bringErrorText(new ApiError(409, "not_running", ""))).toBe(
      "la terminal no está en marcha",
    );
    expect(
      bringErrorText(new ApiError(400, "launch_rejected", "pull request api#9 is closed")),
    ).toBe("pull request api#9 is closed");
    expect(bringErrorText(new ApiError(400, "jira_not_configured", ""))).toBe(
      "Jira no está configurado",
    );
  });
});

describe("pasted images", () => {
  const file = (type: string, size = 4) => new File([new Uint8Array(size)], "x", { type });
  // The items a clipboard carries, as the paste event hands them over.
  const clipboard = (...items: { kind: string; type: string; file?: File }[]) =>
    ({
      items: items.map((i) => ({ ...i, getAsFile: () => i.file ?? null })),
    }) as unknown as DataTransfer;

  test("every image in order wins over the text beside it; other files are counted", () => {
    const png = file("image/png");
    const jpg = file("image/jpeg");
    const both = clipboard(
      { kind: "string", type: "text/plain" },
      { kind: "file", type: "image/png", file: png },
      { kind: "file", type: "application/pdf", file: file("application/pdf") },
      { kind: "file", type: "image/jpeg", file: jpg },
    );
    expect(imagesIn(both)).toEqual({ images: [png, jpg], others: 1 });
    expect(imagesIn(clipboard({ kind: "string", type: "text/plain" }))).toEqual({
      images: [],
      others: 0,
    });
    expect(
      imagesIn(clipboard({ kind: "file", type: "image/svg+xml", file: file("image/svg+xml") })),
    ).toEqual({ images: [], others: 1 });
    expect(imagesIn(null)).toEqual({ images: [], others: 0 });
  });

  test("a paste says what went wrong, and nothing when every image was typed", () => {
    expect(pasteProblem({ kept: ["a"], typed: 1, failed: [], refused: null })).toBeNull();
    expect(
      pasteProblem({ kept: ["a"], typed: 0, failed: [], refused: "la terminal no está en marcha" }),
    ).toMatch(/^No se ha pegado la imagen: la terminal no está en marcha\. Está en el historial/);
    expect(pasteProblem({ kept: ["a", "b"], typed: 0, failed: [], refused: "x" })).toMatch(
      /^No se ha pegado ninguna de las 2 imágenes: x\. Están en el historial/,
    );
    expect(
      pasteProblem({
        kept: ["a", "b", "c", "d", "e", "f", "g"],
        typed: 5,
        failed: [],
        refused: null,
      }),
    ).toBe("Se han pegado 5 de 7 imágenes: como mucho 5 a la vez; el resto está en el historial.");
    expect(
      pasteProblem({ kept: ["a"], typed: 1, failed: ["la imagen pasa de 10 MB"], refused: null }),
    ).toBe("No se ha guardado una imagen: la imagen pasa de 10 MB.");
    expect(pasteProblem({ kept: [], typed: 0, failed: ["x", "y"], refused: null })).toBe(
      "No se han guardado 2 imágenes: x.",
    );
  });

  test("an image over the cap is refused before it is sent", async () => {
    await expect(uploadImage(file("image/png", (10 << 20) + 1))).rejects.toThrow("10 MB");
  });

  test("every focus tells the hub, with the label cut; a failed send is dropped", async () => {
    const sent: [string, string][] = [];
    const saved = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent.push([url, String(init.body)]);
      if (sent.length === 3) throw new TypeError("Failed to fetch");
      return new Response("{}");
    }) as typeof fetch;
    try {
      reportTarget("t1", "Claude · repo/app");
      reportTarget("t2", "x".repeat(100));
      reportTarget("t1", "Claude · repo/app");
      await Bun.sleep(1);
      expect(sent).toEqual([
        ["/api/images/target", JSON.stringify({ terminal: "t1", label: "Claude · repo/app" })],
        ["/api/images/target", JSON.stringify({ terminal: "t2", label: "x".repeat(80) })],
        ["/api/images/target", JSON.stringify({ terminal: "t1", label: "Claude · repo/app" })],
      ]);
    } finally {
      globalThis.fetch = saved;
    }
  });

  test("the server's refusals read as words", () => {
    expect(bringErrorText(new ApiError(403, "capture_denied", ""))).toContain(
      "Grabación de pantalla",
    );
    expect(bringErrorText(new ApiError(400, "bad_image", ""))).toContain("no es una imagen");
    expect(bringErrorText(new ApiError(413, "too_large", ""))).toBe("la imagen pasa de 10 MB");
    expect(bringErrorText(new ApiError(410, "image_gone", ""))).toContain("ya no está");
  });

  test("the mode is content unless this browser chose task, also under the old name", () => {
    let disk = memoryStorage("local", {});
    expect(bringMode.get()).toBe("content");
    disk.restore();
    disk = memoryStorage("local", { "bring-mode": "task" });
    expect(bringMode.get()).toBe("task");
    expect(Object.fromEntries(disk.data)).toEqual({ "aos.bring-mode": "task" });
    disk.restore();
    disk = memoryStorage("local", { "aos.bring-mode": "other" });
    expect(bringMode.get()).toBe("content");
    disk.restore();
  });
});
