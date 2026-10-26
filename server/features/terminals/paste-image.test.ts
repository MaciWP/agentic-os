import { describe, expect, test } from "bun:test";
import { ImageError } from "../images/store.ts";
import { typedPath } from "./paste-image.ts";

describe("typedPath", () => {
  test("one line a shell reads as one path", () => {
    expect(typedPath("/a b/c'd\\e.png", "darwin")).toBe("/a\\ b/c\\'d\\\\e.png");
    expect(typedPath("/plain/x.png", "darwin")).toBe("/plain/x.png");
  });

  test("on Windows the path goes in double quotes, backslashes as they are", () => {
    expect(typedPath("C:\\Users\\a b\\x.png", "win32")).toBe('"C:\\Users\\a b\\x.png"');
    expect(() => typedPath('C:\\a"b.png', "win32")).toThrow(ImageError);
  });

  test("never types a control character", () => {
    for (const platform of ["darwin", "win32"] as const)
      for (const p of ["/a\nb.png", "/a\rb.png", "/a\u001bb.png"])
        expect(() => typedPath(p, platform)).toThrow(ImageError);
  });
});
