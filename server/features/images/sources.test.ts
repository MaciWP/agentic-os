import { describe, expect, test } from "bun:test";
import { FOLDER_TTL_MS, imageSources, type Run, screenshotFolder } from "./sources.ts";

const answer =
  (code: number, stdout: string, seen: string[][] = []): Run =>
  async (argv) => {
    seen.push(argv);
    return { code, stdout };
  };

describe("screenshotFolder", () => {
  test("macOS: the screencapture location, with ~ expanded", async () => {
    const seen: string[][] = [];
    const dir = await screenshotFolder({
      platform: "darwin",
      home: "/Users/me",
      run: answer(0, "~/Pictures/Shots\n", seen),
    });
    expect(dir).toBe("/Users/me/Pictures/Shots");
    expect(seen).toEqual([["/usr/bin/defaults", "read", "com.apple.screencapture", "location"]]);
    expect(
      await screenshotFolder({ platform: "darwin", home: "/h", run: answer(0, "/Volumes/X\n") }),
    ).toBe("/Volumes/X");
  });

  test("macOS: unset, unreadable or relative means the Desktop", async () => {
    const failing: Run = async () => {
      throw new Error("spawn failed");
    };
    for (const run of [answer(1, ""), answer(0, "Shots\n"), answer(0, "\n"), failing])
      expect(await screenshotFolder({ platform: "darwin", home: "/Users/me", run })).toBe(
        "/Users/me/Desktop",
      );
  });

  test("Windows: Screenshots under the Pictures shell folder, else under the profile", async () => {
    const seen: string[][] = [];
    expect(
      await screenshotFolder({
        platform: "win32",
        home: "C:\\Users\\me",
        run: answer(0, "D:\\OneDrive\\Pictures\r\n", seen),
      }),
    ).toBe("D:\\OneDrive\\Pictures\\Screenshots");
    expect(seen[0]?.[0]).toBe("powershell.exe");
    expect(seen[0]).toContain("-NonInteractive");
    expect(
      await screenshotFolder({ platform: "win32", home: "C:\\Users\\me", run: answer(1, "") }),
    ).toBe("C:\\Users\\me\\Pictures\\Screenshots");
  });

  test("other platforms have no screenshots folder", async () => {
    expect(await screenshotFolder({ platform: "linux", run: answer(0, "/x") })).toBeNull();
  });
});

describe("imageSources", () => {
  test("a configured folder wins and the OS is never asked", async () => {
    let asked = 0;
    const sources = imageSources("/data/pastes", "/shots", async () => {
      asked++;
      return "/os";
    });
    expect(await sources()).toEqual([
      { id: "pasted", dir: "/data/pastes", own: true },
      { id: "captured", dir: "/data/pastes/captures", own: true },
      { id: "folder", dir: "/shots", own: false },
    ]);
    expect(asked).toBe(0);
  });

  test("the OS's folder is asked once a minute, and none means the app's own images only", async () => {
    let asked = 0;
    let now = 0;
    const sources = imageSources(
      "/p",
      undefined,
      async () => {
        asked++;
        return asked === 1 ? "/os" : null;
      },
      () => now,
    );
    expect((await sources()).map((s) => s.dir)).toEqual(["/p", "/p/captures", "/os"]);
    now = FOLDER_TTL_MS;
    await sources();
    expect(asked).toBe(1);
    now = FOLDER_TTL_MS + 1;
    expect((await sources()).map((s) => s.dir)).toEqual(["/p", "/p/captures"]);
    expect(asked).toBe(2);
  });
});
