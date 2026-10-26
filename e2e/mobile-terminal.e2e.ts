import { expect, type Page, test } from "@playwright/test";
import { noClippedControls, origin, waitReady } from "./helpers.ts";

const headers = { origin, "content-type": "application/json" };

// A phone: touch only, so xterm's own textarea does not raise the keyboard.
test.use({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });

const screenText = async (page: Page, id: string) =>
  ((await (await page.request.get(`/api/terminals/${id}/text`)).json()) as { text: string }).text;

// One gesture step as xterm's touch handling makes it: a CustomEvent with a vertical move.
// With `position`, the step also carries where the finger is, as a real drag does; without it,
// it is an inertia frame, which xterm sends with none.
// The phone's terminal page holds one terminal.
const glide = (page: Page, position: boolean) =>
  page.evaluate(
    ({ position }) => {
      const host = document.querySelector<HTMLElement>("[data-terminal-screen]");
      const screen = host?.querySelector<HTMLElement>(".xterm-screen");
      if (!host || !screen) throw new Error("no terminal screen");
      const box = screen.getBoundingClientRect();
      if (position) {
        const touch = new Touch({
          identifier: 1,
          target: host,
          clientX: box.left + 20,
          clientY: box.top + 20,
        });
        host.dispatchEvent(new TouchEvent("touchmove", { touches: [touch], bubbles: false }));
      }
      const step = document.createEvent("CustomEvent") as CustomEvent & { translationY: number };
      step.initEvent("-xterm-gesturechange", false, true);
      step.translationY = -200;
      screen.dispatchEvent(step);
    },
    { position },
  );

test("a phone types into a shell from the dock, and a touch glide types nothing broken", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/terminals", {
    headers,
    data: { harness: "shell", location: "app" },
  });
  const id = (await created.json()).terminal.id as string;
  try {
    // A link to a terminal (an alert's) opens its page on a phone.
    await page.goto(`/terminales?t=${id}`);
    await expect(page).toHaveURL(new RegExp(`/terminal/${id}$`));
    const view = page.locator("body");
    await waitReady(view, id);
    await expect(view.locator(".xterm-helper-textarea")).toHaveAttribute("inputmode", "none");
    const bar = page.getByRole("textbox", { name: "Escribir en la terminal" });
    const send = page.getByRole("button", { name: "Enviar", exact: true });
    await bar.fill("echo dock-$((40+2))");
    await send.click();
    await expect.poll(() => screenText(page, id)).toContain("dock-42");
    await expect(bar).toHaveValue("");

    // A program that asked for wheel reports, as Claude does, prints what it gets.
    // The marker shows only once the command ran: its typed echo holds no "mouse-2".
    await bar.fill(`printf '\\033[?1000h\\033[?1006h'; echo mouse-$((1+1)); cat -v`);
    await send.click();
    await expect.poll(() => screenText(page, id)).toContain("mouse-2");
    await page.waitForTimeout(300);
    await glide(page, false);
    await glide(page, true);
    await expect.poll(() => screenText(page, id)).toMatch(/\^\[\[<6[45];\d+;\d+M/);
    expect(await screenText(page, id)).not.toContain("NaN");
    // The keys give their room to the text while the keyboard is up.
    await expect(page.getByRole("button", { name: "Ctrl+C", exact: true })).toHaveCount(0);
    await bar.blur();
    await page.getByRole("button", { name: "Ctrl+C", exact: true }).click();
    await bar.fill(`printf '\\033[?1000l\\033[?1006l'`);
    await send.click();
    await noClippedControls(page);
  } finally {
    await request.post(`/api/terminals/${id}/stop`, { headers });
  }
});

test("the letter size changes on this device and stays after a reload", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/terminals", {
    headers,
    data: { harness: "shell", location: "app" },
  });
  const id = (await created.json()).terminal.id as string;
  try {
    await page.goto(`/terminal/${id}`);
    const view = page.locator("body");
    await waitReady(view, id);
    const size = () => view.locator(".xterm-rows").evaluate((el) => getComputedStyle(el).fontSize);
    await expect.poll(size).toBe("13px");
    // In «⋯», which stays open while the size changes.
    await page.getByRole("button", { name: "Más acciones" }).click();
    await page.getByRole("button", { name: "Letra más grande" }).click();
    await page.getByRole("button", { name: "Letra más grande" }).click();
    await expect.poll(size).toBe("15px");
    await page.reload();
    await waitReady(view, id);
    await expect.poll(size).toBe("15px");
    await page.getByRole("button", { name: "Más acciones" }).click();
    await page.getByRole("button", { name: "Letra más pequeña" }).click();
    await expect.poll(size).toBe("14px");
  } finally {
    await request.post(`/api/terminals/${id}/stop`, { headers });
  }
});

// The terminal's size as the shell sees it, one line per `stty size` it printed.
const sizes = async (page: Page, id: string) =>
  (await screenText(page, id)).split("\n").filter((line) => /^\d+ \d+$/.test(line.trim()));

// A shell gives the real terminal; the agent is a fixture, so a test never starts or addresses
// a real model.
const asAgent = (page: Page, id: string) =>
  page.route("**/api/terminals", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      response,
      json: {
        ...data,
        terminals: data.terminals.map((t: { id: string }) =>
          t.id === id
            ? {
                ...t,
                harness: "claude",
                agent: { sessionId: null, state: "needs_you", asks: "permission" },
              }
            : t,
        ),
      },
    });
  });

test("a phone reads an agent's conversation as Markdown and answers its question while the desktop keeps the terminal and its size", async ({
  browser,
  page,
  request,
}) => {
  const created = await request.post("/api/terminals", {
    headers,
    data: { harness: "shell", location: "app" },
  });
  const id = (await created.json()).terminal.id as string;
  // A new context takes this file's `test.use` too: the desktop says it has no touch.
  const desktop = await browser.newContext({
    baseURL: origin,
    viewport: { width: 1280, height: 800 },
    isMobile: false,
    hasTouch: false,
  });
  try {
    const pc = await desktop.newPage();
    await pc.goto(`/terminales?t=${id}`);
    await waitReady(pc.locator(`section[data-terminal-id="${id}"]`), id);
    await request.post(`/api/terminals/${id}/send`, {
      headers,
      data: { text: "stty size; echo keys-$((1+1)); cat -v", enter: true },
    });
    await expect.poll(() => screenText(page, id)).toContain("keys-2");
    const [size] = await sizes(page, id);

    await asAgent(page, id);
    await page.route(`**/api/agents/${id}/conversation`, (route) =>
      route.fulfill({
        json: {
          messages: [
            { role: "user", text: "¿Puedes revisar el login?", at: "2026-10-08T09:00:00.000Z" },
            {
              role: "assistant",
              text: [
                `Falla en la línea 23: ${"una respuesta larga que se lee entera en el móvil ".repeat(6)}`,
                "- el token caduca\n- nadie lo renueva",
                "```ts\nconst expired = token.exp < now;\n```",
              ].join("\n\n"),
              at: "2026-10-08T09:00:05.000Z",
            },
          ],
        },
      }),
    );
    // The list puts the one that asks first; a tap opens its page.
    await page.goto("/terminales");
    const list = page.getByRole("list", { name: "Terminales en marcha" });
    await expect(list.getByRole("link").first()).toHaveAttribute("href", `/terminal/${id}`);
    await noClippedControls(page);
    await page.screenshot({ path: test.info().outputPath("list.png") });
    await list.getByRole("link").first().click();
    await expect(page).toHaveURL(new RegExp(`/terminal/${id}$`));

    const reader = page.locator("[data-conversation]");
    await expect(reader.getByRole("article", { name: "Tú" })).toContainText("revisar el login");
    const answer = reader.getByRole("article", { name: "Claude" });
    await expect(answer.locator("li")).toHaveText(["el token caduca", "nadie lo renueva"]);
    await expect(answer.locator("pre code")).toContainText("const expired = token.exp < now;");
    // Reading needs nothing from the desktop: no offer to take the terminal, no key row, and
    // the state lives in the header.
    await expect(page.getByText("Abierta en otra ventana.")).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Teclas de terminal" })).toHaveCount(0);
    await expect(page.getByText("Claude pide permiso en la terminal.")).toHaveCount(0);
    const box = await answer.boundingBox();
    expect(box && box.x + box.width).toBeLessThanOrEqual(412);

    // The question as the terminal draws it, and the keys that answer it.
    const ask = page.getByRole("region", { name: "El agente pregunta" });
    await expect(ask).toContainText("keys-2");
    await page.screenshot({ path: test.info().outputPath("reader.png") });
    await ask.getByRole("button", { name: "↓", exact: true }).click();
    await ask.getByRole("button", { name: "Esc", exact: true }).click();
    await expect.poll(() => screenText(page, id)).toContain("^[[B^[");
    await ask.getByRole("button", { name: "Enter", exact: true }).click();

    // The composer types into the terminal the desktop holds, at the desktop's size.
    const bar = page.getByRole("textbox", { name: "Escribir en la terminal" });
    // Out of `cat -v` (the reading view has no Ctrl+C key; «Ver terminal» has).
    await request.post(`/api/terminals/${id}/send`, { headers, data: { interrupt: true } });
    await bar.fill("echo composer-$((2+3))");
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect.poll(() => screenText(page, id)).toContain("composer-5");
    await expect(bar).toHaveValue("");
    await noClippedControls(page);

    // «⋯» names every other action; «Ver terminal» shows the screen with its keys.
    await page.getByRole("button", { name: "Más acciones" }).click();
    const menu = page.getByRole("menu");
    for (const name of ["Ver terminal", "Mensaje al agente", "Renombrar", "Parar"])
      await expect(menu.getByRole("menuitem", { name, exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("menu.png") });
    await menu.getByRole("menuitem", { name: "Ver terminal" }).click();
    await expect(menu).toHaveCount(0);
    await expect(reader).toHaveCount(0);
    await expect(page.getByText("Abierta en otra ventana.")).toBeVisible();
    const keys = page.getByRole("group", { name: "Teclas de terminal" });
    await bar.fill("stty size");
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await bar.blur();
    await expect.poll(async () => (await sizes(page, id)).length).toBe(2);
    expect(await sizes(page, id)).toEqual([size, size]);
    await keys.getByRole("button", { name: "Ctrl+C", exact: true }).click();
    await page.getByRole("button", { name: "Más acciones" }).click();
    await page.getByRole("menuitem", { name: "Leer" }).click();
    await expect(reader).toBeVisible();

    await page.getByRole("link", { name: "Volver a las terminales" }).click();
    await expect(page).toHaveURL(/\/terminales$/);
    await expect(
      pc.locator(`section[data-terminal-id="${id}"]`).getByText("Abierta en otra ventana."),
    ).toHaveCount(0);
  } finally {
    // Stopping the terminal makes the page read the list again while the test closes it: the
    // fixture's fetch would end with no body.
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await desktop.close();
    await request.post(`/api/terminals/${id}/stop`, { headers });
  }
});

// A microphone that hears a tone: the real capture runs on it, only the transcription is a
// fixture.
const toneMic = () => {
  navigator.mediaDevices.getUserMedia = async () => {
    const ctx = new AudioContext();
    const tone = ctx.createOscillator();
    const out = ctx.createMediaStreamDestination();
    tone.connect(out);
    tone.start();
    return out.stream;
  };
};

test("a phone dictates into the composer, never into the terminal, and the text waits there when the page was left", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/terminals", {
    headers,
    data: { harness: "shell", location: "app" },
  });
  const id = (await created.json()).terminal.id as string;
  const sends: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith(`/api/terminals/${id}/send`)) sends.push(r.postData() ?? "");
  });
  await page.addInitScript(toneMic);
  await page.route("**/api/voice", (route) =>
    route.fulfill({ json: { configured: true, state: "ready", detail: null } }),
  );
  await page.route("**/api/voice/warm", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/voice/report", (route) => route.fulfill({ json: {} }));
  let answer = () => {};
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  await page.route("**/api/voice/transcribe", async (route) => {
    await answered;
    await route.fulfill({ json: { text: "hola" } });
  });
  try {
    await page.goto(`/terminal/${id}`);
    await waitReady(page.locator("body"), id);
    const bar = page.getByRole("textbox", { name: "Escribir en la terminal" });
    await bar.fill("ya escrito");
    await page.getByRole("button", { name: "Dictar" }).click();
    await expect(page.getByRole("button", { name: "Parar el dictado" })).toBeVisible();
    await page.waitForTimeout(600);
    await page.getByRole("button", { name: "Parar el dictado" }).click();
    await expect(page.getByRole("button", { name: "Descartar el dictado" })).toBeVisible();
    // Left before the text comes back, and back again.
    await page.getByRole("link", { name: "Volver a las terminales" }).click();
    await expect(page).toHaveURL(/\/terminales$/);
    answer();
    await page.locator(`a[href="/terminal/${id}"]`).click();
    await expect(bar).toHaveValue("ya escrito hola ");
    expect(sends).toEqual([]);
    expect(await screenText(page, id)).not.toContain("hola");
    await page.screenshot({ path: test.info().outputPath("dictated.png") });
  } finally {
    await request.post(`/api/terminals/${id}/stop`, { headers });
  }
});

test("opening the phone's keyboard keeps the rows of the terminal the phone holds", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/terminals", {
    headers,
    data: { harness: "shell", location: "app" },
  });
  const id = (await created.json()).terminal.id as string;
  try {
    await page.goto(`/terminal/${id}`);
    await waitReady(page.locator("body"), id);
    const bar = page.getByRole("textbox", { name: "Escribir en la terminal" });
    const send = page.getByRole("button", { name: "Enviar", exact: true });
    await bar.fill("stty size");
    await send.click();
    await expect.poll(async () => (await sizes(page, id)).length).toBe(1);
    const [before] = await sizes(page, id);
    // The keyboard opens over the bar: the page gets shorter while the bar has the focus.
    await bar.focus();
    await page.setViewportSize({ width: 412, height: 560 });
    await bar.fill("stty size");
    await send.click();
    await expect.poll(async () => (await sizes(page, id)).length).toBe(2);
    expect((await sizes(page, id))[1]).toBe(before);
    // The prompt, at the bottom of the screen, stays in view above the keyboard.
    const screen = page.locator("[data-terminal-screen]");
    expect(await screen.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    // Closed, the terminal fits the page again.
    await bar.blur();
    await page.setViewportSize({ width: 412, height: 915 });
    await expect.poll(() => screen.evaluate((el) => el.scrollTop)).toBe(0);
  } finally {
    await request.post(`/api/terminals/${id}/stop`, { headers });
  }
});
