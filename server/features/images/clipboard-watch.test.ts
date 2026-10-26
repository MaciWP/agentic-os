import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_PASTE_IMAGE_BYTES } from "../../../shared/terminals.ts";
import { ClipboardWatch, WATCH_RETRIES, type WatchProcess, watchArgv } from "./clipboard-watch.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const line = (o: unknown) => `${JSON.stringify(o)}\n`;

// A script that prints these chunks, then ends with this code and stderr.
function script(chunks: string[], end: { code?: number; stderr?: string } = {}) {
  let killed = false;
  const proc: WatchProcess = {
    stdout: new ReadableStream({
      start(c) {
        for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
        c.close();
      },
    }),
    stderr: new Response(end.stderr ?? "").body as ReadableStream<Uint8Array>,
    exited: Promise.resolve(end.code ?? 0),
    kill: () => {
      killed = true;
    },
  };
  return { proc, killed: () => killed };
}

function quiet<T>(run: () => Promise<T>): Promise<{ result: T; errors: string[] }> {
  const errors: string[] = [];
  const original = console.error;
  console.error = (msg: string) => errors.push(msg.replace(/^\S+ (INFO|WARN|ERROR) /, ""));
  return run()
    .then((result) => ({ result, errors }))
    .finally(() => {
      console.error = original;
    });
}

describe("clipboard watch", () => {
  test("each system runs its own script with the server's pid and the size cap", () => {
    const mac = watchArgv("darwin", 42);
    expect(mac?.slice(0, 3)).toEqual(["/usr/bin/osascript", "-l", "JavaScript"]);
    expect(mac?.[3]).toEndWith("/clipboard-watch.js");
    expect(mac?.slice(4)).toEqual(["42", String(MAX_PASTE_IMAGE_BYTES)]);
    const win = watchArgv("win32", 42);
    expect(win?.slice(0, 7)).toEqual([
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
    ]);
    expect(win?.[7]).toEndWith("clipboard-watch.ps1");
    expect(win?.slice(8)).toEqual(["-ServerId", "42", "-Max", String(MAX_PASTE_IMAGE_BYTES)]);
    expect(watchArgv("linux", 42)).toBeNull();
  });

  test("images arrive whole across chunks and are kept in order; junk is skipped", async () => {
    const kept: number[][] = [];
    const image = line({ image: png.toString("base64") });
    const { proc } = script([
      line({ ready: true }),
      image.slice(0, 20),
      `${image.slice(20)}not json\n{"image":"%%%"}\n`,
      line({ tooLarge: 99 }) + line({ image: Buffer.from([...png, 1]).toString("base64") }),
    ]);
    const watch = new ClipboardWatch(
      async (bytes) => {
        await Bun.sleep(bytes.length % 2 ? 1 : 10);
        kept.push([...bytes]);
      },
      { platform: "darwin", spawn: () => proc, retryMs: 60_000 },
    );
    const { errors } = await quiet(async () => {
      watch.start();
      await watch.done;
    });
    expect(kept).toEqual([[...png], [...png, 1]]);
    expect(errors.filter((e) => e.includes("unreadable line"))).toHaveLength(2);
    expect(errors).toContain("clipboard watch: a copied image of 99 bytes is too large");
    watch.stop();
  });

  test("a failed save is said and the next image is still kept", async () => {
    let calls = 0;
    const { proc } = script([
      line({ ready: true }),
      line({ image: "AAAA" }),
      line({ image: "AQID" }),
    ]);
    const watch = new ClipboardWatch(
      async () => {
        if (++calls === 1) throw new Error("not a PNG");
      },
      { platform: "darwin", spawn: () => proc, retryMs: 60_000 },
    );
    const { errors } = await quiet(async () => {
      watch.start();
      await watch.done;
    });
    expect(calls).toBe(2);
    expect(errors).toContain("clipboard watch: not kept: not a PNG");
    watch.stop();
  });

  test("a script that dies is failed with its words, retried a few times, then left failed", async () => {
    let spawned = 0;
    const watch = new ClipboardWatch(async () => {}, {
      platform: "darwin",
      spawn: () => {
        spawned++;
        return script([], { code: 1, stderr: "execution error: -1743\n" }).proc;
      },
      retryMs: 1,
    });
    await quiet(async () => {
      watch.start();
      await Bun.sleep(80);
    });
    expect(spawned).toBe(WATCH_RETRIES + 1);
    expect(watch.state()).toEqual({ state: "failed", detail: "ended (1): execution error: -1743" });
    watch.stop();
    expect(watch.state()).toEqual({ state: "off", detail: null });
  });

  test("a script that says ready and dies at once still runs out of retries", async () => {
    let spawned = 0;
    const watch = new ClipboardWatch(async () => {}, {
      platform: "darwin",
      spawn: () => {
        spawned++;
        return script([line({ ready: true })], { code: 1, stderr: "Not authorized\n" }).proc;
      },
      retryMs: 1,
    });
    await quiet(async () => {
      watch.start();
      await Bun.sleep(80);
    });
    expect(spawned).toBe(WATCH_RETRIES + 1);
    expect(watch.state()).toEqual({ state: "failed", detail: "ended (1): Not authorized" });
    watch.stop();
  });

  test("a script that worked a long while before ending starts a fresh count", async () => {
    let spawned = 0;
    const watch = new ClipboardWatch(async () => {}, {
      platform: "darwin",
      spawn: () => {
        spawned++;
        return script([line({ ready: true })], { code: 1 }).proc;
      },
      retryMs: 1,
      // Every run counts as long: it never runs out.
      stableMs: 0,
    });
    await quiet(async () => {
      watch.start();
      await Bun.sleep(80);
    });
    expect(spawned).toBeGreaterThan(WATCH_RETRIES + 1);
    watch.stop();
  });

  test("stop kills the script and cancels a pending retry", async () => {
    const running = script([line({ ready: true })]);
    // The script stays alive until killed.
    let exit = (_: number) => {};
    running.proc.exited = new Promise((r) => {
      exit = r;
    });
    let spawned = 0;
    const watch = new ClipboardWatch(async () => {}, {
      platform: "darwin",
      spawn: () => {
        spawned++;
        return running.proc;
      },
      retryMs: 1,
    });
    watch.start();
    await Bun.sleep(5);
    expect(watch.state().state).toBe("watching");
    watch.stop();
    expect(running.killed()).toBe(true);
    exit(143);
    await watch.done;
    await Bun.sleep(10);
    expect(spawned).toBe(1);
    expect(watch.state().state).toBe("off");
  });

  test("on a system without a script it says so and spawns nothing", () => {
    const watch = new ClipboardWatch(async () => {}, {
      platform: "linux",
      spawn: () => {
        throw new Error("spawned");
      },
    });
    watch.start();
    expect(watch.state()).toEqual({
      state: "failed",
      detail: "no clipboard watcher for this system",
    });
  });

  // The real JXA script, on a private pasteboard: the user's clipboard is never touched.
  test.skipIf(process.platform !== "darwin")(
    "macOS: the real script reports a copied PNG and a TIFF as PNG, and skips text",
    async () => {
      const board = `aos-test-${randomUUID()}`;
      const put = (type: string, data: string) =>
        Bun.spawnSync([
          "/usr/bin/osascript",
          "-l",
          "JavaScript",
          "-e",
          `ObjC.import("AppKit"); const b = $.NSPasteboard.pasteboardWithName(${JSON.stringify(board)}); b.clearContents; b.setDataForType($.NSData.alloc.initWithBase64EncodedStringOptions(${JSON.stringify(data)}, 0), ${JSON.stringify(type)});`,
        ]);
      const dir = mkdtempSync(join(tmpdir(), "aos-watch-"));
      writeFileSync(join(dir, "one.png"), png);
      Bun.spawnSync(["/usr/bin/sips", "-s", "format", "tiff", "one.png", "--out", "one.tiff"], {
        cwd: dir,
      });
      const tiff = readFileSync(join(dir, "one.tiff"));
      rmSync(dir, { recursive: true });
      const kept: Uint8Array[] = [];
      const watch = new ClipboardWatch(async (bytes) => kept.push(bytes), {
        spawn: (argv) =>
          Bun.spawn([...argv, board], { stdin: "ignore", stdout: "pipe", stderr: "pipe" }),
      });
      watch.start();
      const until = async (ok: () => boolean) => {
        for (let i = 0; i < 60 && !ok(); i++) await Bun.sleep(100);
      };
      await until(() => watch.state().state === "watching");
      expect(watch.state().state).toBe("watching");
      put("public.png", png.toString("base64"));
      await until(() => kept.length === 1);
      put("public.utf8-plain-text", Buffer.from("hola").toString("base64"));
      await Bun.sleep(700);
      put("public.tiff", tiff.toString("base64"));
      await until(() => kept.length === 2);
      watch.stop();
      expect(Buffer.from(kept[0] ?? []).equals(png)).toBe(true);
      expect(kept).toHaveLength(2);
      expect([...(kept[1] ?? []).slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    },
    15_000,
  );
});
