import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { origin, removeTerminals, waitReady } from "./helpers.ts";

const run = promisify(execFile);

// The terminal window: xterm is loaded only there, it fits the window, keys reach the
// shell, and a reload shows the same screen. A plain shell is the only thing launched,
// and it is removed again: DELETE answers 200 with removed false until the shell has exited.

// xterm's own code, by a message only the library has: the app's bundle names `.xterm` in its
// selectors, so the word alone would find it on every page.
const XTERM = "Terminal requires a parent element";

test("the dashboard loads no xterm code", async ({ page }) => {
  const scripts: Promise<{ url: string; xterm: boolean }>[] = [];
  page.on("response", (r) => {
    if (r.request().resourceType() !== "script") return;
    scripts.push(r.text().then((js) => ({ url: r.url(), xterm: js.includes(XTERM) })));
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Ticket a ticket" })).toBeVisible();
  const loaded = await Promise.all(scripts);
  expect(loaded.length).toBeGreaterThan(0);
  expect(loaded.filter((s) => s.xterm).map((s) => s.url)).toEqual([]);

  // The terminal window does load it, whatever the id: the marker still names xterm's code.
  scripts.length = 0;
  await page.goto("/terminal/nope");
  await expect.poll(async () => (await Promise.all(scripts)).some((s) => s.xterm)).toBe(true);
});

test("a terminal window fits, echoes keys and comes back the same after a reload", async ({
  page,
}) => {
  const api = (path: string, method = "POST", data: unknown = {}) =>
    page.request.fetch(path, {
      method,
      headers: { origin, "content-type": "application/json" },
      data,
    });
  const res = await api("/api/terminals", "POST", { harness: "shell", location: "app" });
  expect(res.ok()).toBe(true);
  const { terminal } = (await res.json()) as { terminal: { id: string } };
  try {
    await page.goto(`/terminal/${terminal.id}`);
    const screen = page.locator(".xterm-screen");
    await expect(screen).toBeVisible();
    await expect(page.getByText("en marcha")).toBeVisible();
    const box = await screen.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(200);
    expect(box?.height ?? 0).toBeGreaterThan(100);

    // A login shell can take seconds to start under load; type once it has drawn its prompt.
    const rows = page.locator(".xterm-rows");
    await waitReady(page.locator("body"), terminal.id);
    // The shell prints 42aos only if it ran the line; the typed text itself is $((6*7))aos.
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("echo $((6*7))aos");
    await page.keyboard.press("Enter");
    await expect(rows).toContainText("42aos");
    // 🟢 (octal bytes) takes two cells, as TUIs count it: the jump to column 3 overwrites "a".
    // With one cell it would overwrite "b" and print 🟢aX_WIDE.
    await page.keyboard.type("printf '\\360\\237\\237\\242ab\\033[3GX_%s\\n' WIDE");
    await page.keyboard.press("Enter");
    await expect(rows).toContainText("🟢X_WIDE");

    await page.reload();
    await expect(page.getByText("en marcha")).toBeVisible();
    await expect(rows).toContainText("42aos");
    // The server's copy of the screen counts it the same.
    await expect(rows).toContainText("🟢X_WIDE");
    await expect(rows).toContainText("echo $((6*7))aos");

    // Read the actual PTY bytes: Shift+Enter must remain distinct, without a second CR.
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type(
      "stty -echo -icanon -icrnl min 1 time 0; printf '\\nKEY_%s\\n' READY; od -An -tx1 -N8; stty sane",
    );
    await page.keyboard.press("Enter");
    await expect(rows).toContainText("KEY_READY");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.press("Enter");
    await expect(rows).toContainText(/1b\s+5b\s+31\s+33\s+3b\s+32\s+75\s+0d/);
  } finally {
    await removeTerminals(page.request, [terminal.id]);
  }
});

test("a program's copy (OSC 52) reaches this window's clipboard once, never again on a reload", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const res = await page.request.post("/api/terminals", {
    headers: { origin, "content-type": "application/json" },
    data: { harness: "shell", location: "app" },
  });
  expect(res.ok()).toBe(true);
  const { terminal } = (await res.json()) as { terminal: { id: string } };
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  try {
    await page.goto(`/terminal/${terminal.id}`);
    await waitReady(page.locator("body"), terminal.id);
    await page.evaluate(() => navigator.clipboard.writeText("antes"));
    // What Claude sends on a mouse copy: ESC ]52;c;<base64> BEL, here with an ñ in octal.
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type(
      "printf '\\033]52;c;%s\\007' \"$(printf 'copiado \\303\\261' | base64)\"; echo OSC_SENT",
    );
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText("OSC_SENT");
    await expect.poll(clipboard).toBe("copiado ñ");

    await page.evaluate(() => navigator.clipboard.writeText("después"));
    await page.reload();
    await expect(page.getByText("en marcha")).toBeVisible();
    await expect(page.locator(".xterm-rows")).toContainText("OSC_SENT");
    expect(await clipboard()).toBe("después");
  } finally {
    await removeTerminals(page.request, [terminal.id]);
  }
});

test.describe("from a Windows PC", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  });

  test("a drag selects and Ctrl+C copies it; with nothing selected Ctrl+C still interrupts", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const res = await page.request.post("/api/terminals", {
      headers: { origin, "content-type": "application/json" },
      data: { harness: "shell", location: "app" },
    });
    expect(res.ok()).toBe(true);
    const { terminal } = (await res.json()) as { terminal: { id: string } };
    try {
      await page.goto(`/terminal/${terminal.id}`);
      await waitReady(page.locator("body"), terminal.id);
      await page.evaluate(() => navigator.clipboard.writeText("antes"));
      const rows = page.locator(".xterm-rows");
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.type("clear; echo COPY_$((2*3))_ME");
      await page.keyboard.press("Enter");
      const line = rows.locator("div", { hasText: /^COPY_6_ME/ });
      await expect(line).toBeVisible();
      // A drag along the printed line, as a mouse does it.
      const box = await line.boundingBox();
      if (!box) throw new Error("no line");
      await page.mouse.move(box.x + 1, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 6 });
      await page.mouse.up();
      await page.keyboard.press("Control+C");
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toMatch(/^COPY_6_ME/);
      // The selection is gone after the copy: the next Ctrl+C reaches the program as ^C (03).
      await page.keyboard.type(
        "stty -echo -icanon -isig min 1 time 0; printf '\\nINT_%s\\n' READY; od -An -tx1 -N1; stty sane",
      );
      await page.keyboard.press("Enter");
      await expect(rows).toContainText("INT_READY");
      await page.keyboard.press("Control+C");
      await expect(rows).toContainText(/INT_READY\s*03/);
    } finally {
      await removeTerminals(page.request, [terminal.id]);
    }
  });
});

test("aos types into a terminal while its window stays open and keeps taking keys", async ({
  page,
}) => {
  const aos = async (...args: string[]) =>
    (await run("bun", ["scripts/aos.ts", ...args], { env: { ...process.env, AOS_URL: origin } }))
      .stdout;
  const { id } = JSON.parse(await aos("create", "--harness", "shell", "--location", "app"));
  try {
    await page.goto(`/terminal/${id}`);
    await expect(page.getByText("en marcha")).toBeVisible();
    const rows = page.locator(".xterm-rows");
    await waitReady(page.locator("body"), id);

    await aos("send", id, "--text", "echo $((6*7))cli", "--enter");
    await expect(rows).toContainText("42cli");
    await aos("wait", id, "--quiet-ms", "300", "--timeout-ms", "5000");
    expect(await aos("read", id, "--plain")).toContain("42cli");

    // Still the attached window: no takeover notice, and keys still reach the shell.
    await expect(page.getByText(/otra ventana/i)).toHaveCount(0);
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("echo $((1+1))win");
    await page.keyboard.press("Enter");
    await expect(rows).toContainText("2win");
  } finally {
    await removeTerminals(page.request, [id]);
  }
});

test("a second window takes the terminal; the first offers Traer aquí and never takes it back alone", async ({
  page,
  context,
}) => {
  const api = (path: string, method = "POST", data: unknown = {}) =>
    page.request.fetch(path, {
      method,
      headers: { origin, "content-type": "application/json" },
      data,
    });
  const { terminal } = (await (
    await api("/api/terminals", "POST", { harness: "shell", location: "app" })
  ).json()) as { terminal: { id: string } };
  try {
    await page.goto(`/terminal/${terminal.id}`);
    await expect(page.getByText("en marcha")).toBeVisible();

    const other = await context.newPage();
    await other.goto(`/terminal/${terminal.id}`);
    await expect(other.getByText("en marcha")).toBeVisible();
    await expect(page.getByText("Abierta en otra ventana.")).toBeVisible();
    // Nothing comes back on its own: the second window keeps the terminal.
    await page.waitForTimeout(1500);
    await expect(other.getByText("Abierta en otra ventana.")).toHaveCount(0);

    await page.getByRole("button", { name: "Traer aquí" }).click();
    await expect(page.getByText("Abierta en otra ventana.")).toHaveCount(0);
    await expect(other.getByText("Abierta en otra ventana.")).toBeVisible();
    const rows = page.locator(".xterm-rows");
    await waitReady(page.locator("body"), terminal.id);
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("echo $((3*3))back");
    await page.keyboard.press("Enter");
    await expect(rows).toContainText("9back");
    await other.close();
  } finally {
    await removeTerminals(page.request, [terminal.id]);
  }
});

test("the scrollbar shows on scroll as a visible pill and dragging it reaches the top", async ({
  page,
}) => {
  const api = (path: string, method = "POST", data: unknown = {}) =>
    page.request.fetch(path, {
      method,
      headers: { origin, "content-type": "application/json" },
      data,
    });
  const { terminal } = (await (
    await api("/api/terminals", "POST", { harness: "shell", location: "app" })
  ).json()) as { terminal: { id: string } };
  try {
    await page.goto(`/terminal/${terminal.id}`);
    await expect(page.getByText("en marcha")).toBeVisible();
    const rows = page.locator(".xterm-rows");
    await waitReady(page.locator("body"), terminal.id);
    // The typed line reads TOP_%s; only the printed one reads TOP_MARK.
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("printf 'TOP_%s\\n' MARK; seq 1 3000; printf 'END_%s\\n' MARK");
    await page.keyboard.press("Enter");
    await expect(rows).toContainText("END_MARK");
    await expect(rows).not.toContainText("TOP_MARK");

    const bar = page.locator(".xterm-scrollable-element > .xterm-scrollbar.xterm-vertical");
    const slider = bar.locator(".xterm-slider");
    const screen = page.locator(".xterm-screen");
    await screen.hover();
    await page.mouse.wheel(0, -400);
    await expect(bar).toHaveClass(/\bxterm-visible\b/);
    const look = await slider.evaluate((el) => {
      const s = getComputedStyle(el);
      return { radius: s.borderTopLeftRadius, clip: s.backgroundClip, color: s.backgroundColor };
    });
    expect(look.radius).toBe("999px");
    expect(look.clip).toBe("padding-box");
    expect(look.color).toMatch(/^rgba\(228, 228, 234, 0\.3\d*\)$/);

    const thumb = await slider.boundingBox();
    const track = await bar.boundingBox();
    if (!thumb || !track) throw new Error("scrollbar not laid out");
    await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
    await page.mouse.down();
    await page.mouse.move(thumb.x + thumb.width / 2, track.y - 50, { steps: 10 });
    await page.mouse.up();
    await expect(rows).toContainText("TOP_MARK");
  } finally {
    await removeTerminals(page.request, [terminal.id]);
  }
});

test("a window that takes a terminal of another size keeps the snapshot's size until it is written", async ({
  page,
  context,
}) => {
  const api = (path: string, method = "POST", data: unknown = {}) =>
    page.request.fetch(path, {
      method,
      headers: { origin, "content-type": "application/json" },
      data,
    });
  const { terminal } = (await (
    await api("/api/terminals", "POST", { harness: "shell", location: "app" })
  ).json()) as { terminal: { id: string } };
  try {
    await page.goto(`/terminal/${terminal.id}`);
    await expect(page.getByText("en marcha")).toBeVisible();

    // A smaller window takes it: the snapshot comes at the first window's size, and only the
    // fit that follows its write may resize the program.
    const other = await context.newPage();
    await other.setViewportSize({ width: 760, height: 480 });
    const sizes: { snapshot?: string; sent: string[] } = { sent: [] };
    other.on("websocket", (ws) => {
      ws.on("framereceived", ({ payload }) => {
        if (typeof payload !== "string" || !payload.startsWith('{"type":"snapshot"')) return;
        const { cols, rows } = JSON.parse(payload) as { cols: number; rows: number };
        sizes.snapshot = `${cols}x${rows}`;
      });
      ws.on("framesent", ({ payload }) => {
        if (typeof payload !== "string" || !payload.includes('"type":"resize"')) return;
        const { cols, rows } = JSON.parse(payload) as { cols: number; rows: number };
        sizes.sent.push(`${cols}x${rows}`);
      });
    });
    await other.goto(`/terminal/${terminal.id}`);
    await expect(other.getByText("en marcha")).toBeVisible();
    await expect.poll(() => sizes.sent.length, { timeout: 10_000 }).toBeGreaterThan(0);
    await other.waitForTimeout(500);
    expect(sizes.snapshot).toBeDefined();
    expect(sizes.sent).not.toContain(sizes.snapshot);
    await other.close();
  } finally {
    await removeTerminals(page.request, [terminal.id]);
  }
});

// The other tests draw with the DOM renderer (playwright.config.ts) to read its rows. Here the
// default one: headless Chromium emulates WebGL on the CPU (SwiftShader), where the app keeps
// the DOM renderer. terminal-gpu.e2e.ts gives it the Mac's GPU.
const noRendererChoice = { cookies: [], origins: [] };

test.describe("without a hardware GPU", () => {
  test.use({ storageState: noRendererChoice });

  test("the terminal keeps the DOM renderer", async ({ page }) => {
    const res = await page.request.post("/api/terminals", {
      headers: { origin, "content-type": "application/json" },
      data: { harness: "shell", location: "app" },
    });
    const { terminal } = (await res.json()) as { terminal: { id: string } };
    try {
      await page.goto(`/terminal/${terminal.id}`);
      await expect(page.locator(".xterm-rows")).toHaveCount(1);
      await expect(page.locator(".xterm-screen canvas")).toHaveCount(0);
    } finally {
      await removeTerminals(page.request, [terminal.id]);
    }
  });
});
