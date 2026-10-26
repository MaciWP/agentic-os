import { describe, expect, test } from "bun:test";
import { Autosave, minimalEdit, type SaveStatus } from "./autosave.ts";
import { prettyJson } from "./file-view.tsx";
import { langName, langOf } from "./languages.ts";
import { ancestors, fuzzyScore, rankFiles, resolveLink, wordAt } from "./nav.ts";
import { BRACKET_COLOURS, colourBrackets, paint, type Token, tokenize } from "./tokens.ts";

describe("wordAt", () => {
  test("the identifier around the click, or nothing off one", () => {
    const line = "const total = sum($items, 42);";
    expect(wordAt(line, 8)).toBe("total");
    expect(wordAt(line, 6)).toBe("total");
    expect(wordAt(line, 11)).toBe("total");
    expect(wordAt(line, 20)).toBe("$items");
    expect(wordAt(line, 12)).toBeNull();
    expect(wordAt(line, 27)).toBeNull();
    expect(wordAt("", 0)).toBeNull();
  });
});

describe("quick open", () => {
  const files = [
    "server/features/code/routes.ts",
    "server/features/git/routes.ts",
    "web/features/code/tile.tsx",
    "web/features/git/tile.tsx",
    "docs/routes-notes.md",
  ];

  test("letters must appear in order", () => {
    expect(fuzzyScore("web/features/code/tile.tsx", "cdtile")).not.toBeNull();
    expect(fuzzyScore("web/features/code/tile.tsx", "zz")).toBeNull();
    expect(fuzzyScore("a.ts", "")).toBe(0);
  });

  test("the name beats the folders, and a folder hint narrows it", () => {
    expect(rankFiles(files, "tile")[0]).toMatch(/tile\.tsx$/);
    expect(rankFiles(files, "code tile")[0]).toBe("web/features/code/tile.tsx");
    expect(rankFiles(files, "gitroutes")[0]).toBe("server/features/git/routes.ts");
    expect(rankFiles(files, "qqq")).toEqual([]);
    expect(rankFiles(files, "", 2)).toHaveLength(2);
  });

  test("a link in a file, as a path below the checkout", () => {
    expect(resolveLink("docs/adr/0014.md", "0006-mesa.md")).toBe("docs/adr/0006-mesa.md");
    expect(resolveLink("docs/adr/0014.md", "../voice.md#setup")).toBe("docs/voice.md");
    expect(resolveLink("docs/a.md", "./img/My%20Shot.png")).toBe("docs/img/My Shot.png");
    expect(resolveLink("docs/a.md", "/CLAUDE.md")).toBe("CLAUDE.md");
    expect(resolveLink("a.md", "../out.md")).toBeNull();
    expect(resolveLink("a.md", "https://x.dev/a.md")).toBeNull();
    expect(resolveLink("a.md", "mailto:x@y.z")).toBeNull();
    expect(resolveLink("a.md", "#top")).toBeNull();
  });

  test("a file's folders, outermost first", () => {
    expect(ancestors("a/b/c.ts")).toEqual(["a", "a/b"]);
    expect(ancestors("c.ts")).toEqual([]);
  });
});

describe("languages", () => {
  test("by name, by extension and by every grammar's aliases; unknown stays plain", () => {
    expect(langOf("web/x.tsx")).toBe("tsx");
    expect(langOf("server/x.ts")).toBe("typescript");
    expect(langOf("Dockerfile")).toBe("docker");
    expect(langOf("deploy/Dockerfile.prod")).toBe("docker");
    expect(langOf(".env.local")).toBe("dotenv");
    expect(langOf("a.hbs")).toBe("handlebars");
    expect(langOf("run.ps1")).toBe("powershell");
    expect(langOf("go.cmd")).toBe("bat");
    expect(langOf("events.jsonl")).toBe("jsonl");
    expect(langOf("locale/es/django.po")).toBe("po");
    expect(langOf(".flake8")).toBe("ini");
    expect(langOf(".gitmodules")).toBe("ini");
    expect(langOf("icon.svg")).toBe("xml");
    expect(langOf("README")).toBeNull();
    expect(langOf(".gitignore")).toBeNull();
    expect(langOf("a.unknownext")).toBeNull();
  });

  test("JSON with comments where its tools allow them", () => {
    expect(langOf("tsconfig.json")).toBe("jsonc");
    expect(langOf("app/tsconfig.eslint.json")).toBe("jsonc");
    expect(langOf("tsconfig.app.json")).toBe("jsonc");
    expect(langOf(".vscode/settings.json")).toBe("jsonc");
    expect(langOf("x.code-workspace")).toBe("jsonc");
    expect(langOf("package.json")).toBe("json");
  });

  test("a script without extension by its shebang; a Django template by its tags", () => {
    expect(langOf("bin/aos", "#!/usr/bin/env bun\nimport x;")).toBe("typescript");
    expect(langOf(".githooks/pre-commit", "#!/bin/sh\nset -e")).toBe("shellscript");
    expect(langOf("tool", "#!/usr/bin/env python3\n")).toBe("python");
    expect(langOf("tool", "no shebang")).toBeNull();
    expect(langOf("t/mail.html", "{% extends 'base.html' %}\n<p>")).toBe("jinja-html");
    expect(langOf("index.html", "<!doctype html>")).toBe("html");
  });

  test("names for the header", () => {
    expect(langName("shellscript")).toBe("Shell");
    expect(langName("typescript")).toBe("TypeScript");
    expect(langName("jinja-html")).toBe("Jinja HTML");
  });
});

describe("highlight", () => {
  const text = (lines: Token[][]) => lines.map((l) => l.map((t) => t.content).join("")).join("\n");
  const colour = (lines: Token[][], word: string) =>
    lines
      .flat()
      .find((t) => t.content.includes(word))
      ?.color?.toLowerCase();

  test("TypeScript in VS Code's colours with the JavaScript engine, text kept whole", async () => {
    const source = "export const answer: number = 42; // why\n";
    const lines = await tokenize(source, "typescript");
    expect(text(lines)).toBe(source);
    // Dark+: keywords blue, numbers light green, comments green.
    expect(colour(lines, "const")).toBe("#569cd6");
    expect(colour(lines, "42")).toBe("#b5cea8");
    expect(colour(lines, "why")).toBe("#6a9955");
  });

  test("a Django template colours its tags and its HTML", async () => {
    const painted = await paint(
      "mail.html",
      "{% if user %}\n<p>{{ user.name }}</p>\n{% endif %}\n",
    );
    expect(painted).toMatchObject({ lang: "jinja-html", name: "Jinja HTML" });
    expect(colour(painted.tokens ?? [], "if")).toBe("#c586c0");
    expect(colour(painted.tokens ?? [], "p")).toBe("#569cd6");
  });

  test("brackets by depth in code; in strings and comments they keep their colour", async () => {
    const source = 'f([{ a: "(x)" }]); // (c)\n)\n';
    const lines = await tokenize(source, "typescript");
    expect(text(lines)).toBe(source);
    const brackets = lines
      .flat()
      .filter((t) => /^[()[\]{}]$/.test(t.content))
      .map((t) => `${t.content}${BRACKET_COLOURS.indexOf(t.color as never)}`);
    // The stray `)` on line 2 has nothing open: it keeps the plain colour (-1).
    expect(brackets).toEqual(["(0", "[1", "{2", "}2", "]1", ")0", ")-1"]);
    expect(colour(lines, "(x)")).toBe("#ce9178");
    expect(colour(lines, "(c)")).toBe("#6a9955");
  });

  test("bracket colouring splits a token and keeps its other characters", () => {
    const plain = "#D4D4D4";
    const out = colourBrackets([[{ content: "){(", color: plain }]], plain);
    expect(out[0]?.map((t) => [t.content, t.color])).toEqual([
      [")", plain],
      ["{", BRACKET_COLOURS[0]],
      ["(", BRACKET_COLOURS[1]],
    ]);
  });

  test("plain text, and a file past the caps, have no tokens but say their grammar", async () => {
    expect(await paint("README", "hello")).toEqual({ lang: null, name: "Texto", tokens: null });
    const big = await paint("a.ts", "x\n".repeat(6000));
    expect(big).toEqual({ lang: "typescript", name: "TypeScript", tokens: null });
  });
});

describe("views", () => {
  test("only JSON on one long line gets an indented view", () => {
    const one = JSON.stringify({ items: Array.from({ length: 30 }, (_, i) => ({ i })) });
    expect(prettyJson("a.json", one)).toBe(`${JSON.stringify(JSON.parse(one), null, 2)}\n`);
    expect(prettyJson("a.json", '{"short":1}')).toBeNull();
    expect(prettyJson("a.json", `${one.slice(0, -1)}\n}`)).toBeNull();
    expect(prettyJson("a.json", `${one},`)).toBeNull();
    expect(prettyJson("a.txt", one)).toBeNull();
  });
});

describe("autosave", () => {
  // A fake editor and disk: the text, its revision, the saves asked for and a timer run by hand.
  const rig = (base = "v0") => {
    const ed = { text: "a", rev: 1 };
    const saves: { text: string; base: string; settle: (version: string | Error) => void }[] = [];
    const statuses: SaveStatus[] = [];
    const timers = new Map<number, () => void>();
    const auto = new Autosave(
      {
        save: (text, b) =>
          new Promise((resolve, reject) =>
            saves.push({
              text,
              base: b,
              settle: (v) => (v instanceof Error ? reject(v) : resolve({ version: v })),
            }),
          ),
        text: () => ed.text,
        rev: () => ed.rev,
        isStale: (err) => err instanceof Error && err.message === "stale",
        onStatus: (s) => statuses.push(s),
        timer: {
          set: (run) => {
            const id = timers.size + 1;
            timers.set(id, run);
            return id;
          },
          clear: (id) => timers.delete(id as number),
        },
      },
      base,
      1,
    );
    const type = (text: string) => {
      ed.text = text;
      ed.rev++;
      auto.edited();
    };
    const tick = () => {
      const pending = [...timers.values()];
      timers.clear();
      for (const run of pending) run();
    };
    const settle = async (version: string | Error) => {
      saves.at(-1)?.settle(version);
      await Bun.sleep(0);
    };
    return { ed, auto, saves, statuses, timers, type, tick, settle };
  };

  test("saves once the keys stop, over the version it opened, then is saved", async () => {
    const r = rig();
    r.type("ab");
    r.type("abc");
    expect(r.timers.size).toBe(1);
    expect(r.auto.status).toBe("dirty");
    r.tick();
    expect(r.saves.map(({ text, base }) => [text, base])).toEqual([["abc", "v0"]]);
    await r.settle("v1");
    expect(r.auto.status).toBe("saved");
    expect(r.auto.base).toBe("v1");
    expect(r.statuses).toEqual(["dirty", "dirty", "saving", "saved"]);
  });

  test("one save at a time: keys typed during it go in the next, over the new version", async () => {
    const r = rig();
    r.type("ab");
    void r.auto.flush();
    r.type("abc");
    expect(r.saves).toHaveLength(1);
    await r.settle("v1");
    expect(r.saves.map(({ text, base }) => [text, base])).toEqual([
      ["ab", "v0"],
      ["abc", "v1"],
    ]);
    await r.settle("v2");
    expect(r.auto.status).toBe("saved");
  });

  test("undo back to the saved text is saved, with no request", () => {
    const r = rig();
    r.ed.text = "ab";
    r.ed.rev = 2;
    r.auto.edited();
    r.ed.text = "a";
    r.ed.rev = 1;
    r.auto.edited();
    expect(r.auto.status).toBe("saved");
    expect(r.timers.size).toBe(0);
  });

  test("a poll: same version, take the disk's when clean, wait during a save, conflict when dirty", async () => {
    const r = rig();
    expect(r.auto.disk("v0")).toBe("same");
    expect(r.auto.disk("v9")).toBe("take");
    r.auto.took("v9");
    r.type("mine");
    void r.auto.flush();
    expect(r.auto.disk("v10")).toBe("wait");
    await r.settle("v10");
    expect(r.auto.disk("v10")).toBe("same");
    r.type("mine 2");
    expect(r.auto.disk("v11")).toBe("conflict");
    expect(r.timers.size).toBe(0);
    // Paused: no key and no flush saves over the agent's version.
    r.type("mine 3");
    await r.auto.flush();
    expect(r.saves).toHaveLength(1);
  });

  test("a 409 is a conflict; save mine over it goes against the disk's version", async () => {
    const r = rig();
    r.type("mine");
    r.tick();
    await r.settle(new Error("stale"));
    expect(r.auto.status).toBe("conflict");
    void r.auto.overwrite("v5");
    expect(r.saves.at(-1)).toMatchObject({ text: "mine", base: "v5" });
    await r.settle("v6");
    expect(r.auto.status).toBe("saved");
  });

  test("any other failure says so and the next key tries again", async () => {
    const r = rig();
    r.type("mine");
    r.tick();
    await r.settle(new Error("offline"));
    expect(r.auto.status).toBe("failed");
    r.type("mine!");
    r.tick();
    expect(r.saves.at(-1)).toMatchObject({ text: "mine!", base: "v0" });
  });
});

describe("minimalEdit", () => {
  test("only the middle that changed is replaced", () => {
    expect(minimalEdit("abcdef", "abXYef")).toEqual({ start: 2, end: 4, text: "XY" });
    expect(minimalEdit("same", "same")).toEqual({ start: 4, end: 4, text: "" });
    expect(minimalEdit("aaa", "aaaa")).toEqual({ start: 3, end: 3, text: "a" });
    expect(minimalEdit("x\ny\n", "")).toEqual({ start: 0, end: 4, text: "" });
  });
});
