import { describe, expect, test } from "bun:test";
import type { FolderEntry } from "../../../server/features/files/browse.ts";
import { display, expandHome, fieldText, filterEntries, splitInput } from "./paths.ts";

const home = "/Users/me";
const entry = (name: string): FolderEntry => ({
  name,
  path: `/x/${name}`,
  kind: "folder",
  git: false,
});

describe("path field", () => {
  test("~ means home, only at the start", () => {
    expect(expandHome("~", home)).toBe(home);
    expect(expandHome("~/repos", home)).toBe("/Users/me/repos");
    expect(expandHome("/a/~/b", home)).toBe("/a/~/b");
    expect(expandHome("~other", home)).toBe("~other");
    expect(expandHome("~/repos", null)).toBe("~/repos");
  });

  test("the folder typed and the name being typed after it", () => {
    expect(splitInput("/a/b/c")).toEqual({ dir: "/a/b", tail: "c" });
    expect(splitInput("/a/b/")).toEqual({ dir: "/a/b", tail: "" });
    expect(splitInput("/Us")).toEqual({ dir: "/", tail: "Us" });
    expect(splitInput("/")).toEqual({ dir: "/", tail: "" });
    expect(splitInput("repos")).toEqual({ dir: "", tail: "repos" });
  });

  test("filters by the start of the name, case and accent form ignored", () => {
    const entries = ["Agentic", "api", "Billing", "Diseño"].map(entry);
    expect(filterEntries(entries, "").map((e) => e.name)).toEqual([
      "Agentic",
      "api",
      "Billing",
      "Diseño",
    ]);
    expect(filterEntries(entries, "A").map((e) => e.name)).toEqual(["Agentic", "api"]);
    expect(filterEntries(entries, "gen")).toEqual([]);
    // The name as macOS stores it (n + combining tilde), typed composed.
    const nfd = [entry("Disen\u0303o")];
    expect(filterEntries(nfd, "diseñ").map((e) => e.name)).toEqual(["Disen\u0303o"]);
  });

  test("home is written as ~, and the field ends in a slash", () => {
    expect(display("/Users/me", home)).toBe("~");
    expect(display("/Users/me/repos", home)).toBe("~/repos");
    expect(display("/Users/meow", home)).toBe("/Users/meow");
    expect(display("/opt", null)).toBe("/opt");
    expect(fieldText("/Users/me/repos", home)).toBe("~/repos/");
    expect(fieldText("/Users/me", home)).toBe("~/");
    expect(fieldText("/", home)).toBe("/");
  });
});
