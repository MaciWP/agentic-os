import { afterEach, describe, expect, test } from "bun:test";
import { DiffNote } from "../../../shared/terminals.ts";
import { memoryStorage } from "../../test-storage.ts";
import { parseDiff } from "./diff.ts";
import {
  addNote,
  anchorOf,
  clearSent,
  draftFrom,
  type Note,
  noteStatus,
  notesOf,
  payload,
  pendingOf,
  prune,
  removeNote,
} from "./notes.ts";

const diff = (body: string[]) =>
  parseDiff(["--- a/v.py", "+++ b/v.py", "@@ -40,4 +40,5 @@", ...body, ""].join("\n"));
const BEFORE = diff([
  " def export(request):",
  "-    rows = [s(a) for a in qs]",
  "+    rows = []",
  "+    for a in qs:",
  "+        rows.append(s(a))",
  "     return rows",
]);
// Lines 2..4 of BEFORE are the hunk and its first lines: index 0 and 1 are file headers.
const at = (text: string) => BEFORE.findIndex((l) => l.text === text);

const note = (over: Partial<Note>): Note => ({
  id: "n",
  path: "v.py",
  staged: false,
  lines: ["+    rows = []"],
  side: "new",
  start: 41,
  end: 41,
  kind: "change",
  text: "x",
  created: 0,
  sent: null,
  ...over,
});

describe("draftFrom", () => {
  test("a range of added lines is about the new file, quoted with its marks", () => {
    const d = draftFrom(BEFORE, at("+    rows = []"), at("+        rows.append(s(a))"));
    expect(d).toEqual({
      lines: ["+    rows = []", "+    for a in qs:", "+        rows.append(s(a))"],
      side: "new",
      start: 41,
      end: 43,
    });
  });

  test("removed lines alone are about the old file; picking backwards is the same range", () => {
    const i = at("-    rows = [s(a) for a in qs]");
    expect(draftFrom(BEFORE, i, i)).toMatchObject({ side: "old", start: 41, end: 41 });
    expect(draftFrom(BEFORE, i + 2, i)).toEqual(draftFrom(BEFORE, i, i + 2));
  });

  test("a hunk header, a file header or more than 20 lines is no note", () => {
    const hunk = BEFORE.findIndex((l) => l.kind === "hunk");
    expect(draftFrom(BEFORE, hunk, hunk + 1)).toBeNull();
    expect(draftFrom(BEFORE, 0, 0)).toBeNull();
    const long = diff(Array.from({ length: 21 }, (_, i) => `+l${i}`));
    const first = long.findIndex((l) => l.kind === "add");
    expect(draftFrom(long, first, first + 20)).toBeNull();
    expect(draftFrom(long, first, first + 19)).not.toBeNull();
  });
});

describe("status after sending", () => {
  const sent = note({ lines: ["+    for a in qs:", "+        rows.append(s(a))"], sent: 1 });

  test("pending until sent; sent with no diff to compare yet", () => {
    expect(noteStatus(note({}), BEFORE)).toBe("pending");
    expect(noteStatus(sent, null)).toBe("sent");
  });

  test("untouched while its lines are all there in a row, touched once any changes", () => {
    expect(anchorOf(sent, BEFORE)).toBe(at("+        rows.append(s(a))"));
    expect(noteStatus(sent, BEFORE)).toBe("untouched");
    const after = diff([
      " def export(request):",
      "     rows = [s(a) for a in qs]",
      "     return rows",
    ]);
    expect(noteStatus(sent, after)).toBe("touched");
    // Same text with another mark is another line: committed lines become context.
    const marks = diff(["     for a in qs:", "         rows.append(s(a))"]);
    expect(noteStatus(sent, marks)).toBe("touched");
    expect(noteStatus(sent, [])).toBe("touched");
  });
});

describe("kept notes", () => {
  let disk: ReturnType<typeof memoryStorage>;
  afterEach(() => disk?.restore());

  test("a note survives a reload, sent ones can be cleared, and corrupt storage reads empty", () => {
    disk = memoryStorage("local");
    addNote("envs/a", {
      path: "v.py",
      staged: false,
      lines: ["+x"],
      side: "new",
      start: 1,
      end: 1,
      kind: "nit",
      text: "y",
    });
    addNote("envs/a", {
      path: "w.py",
      staged: false,
      lines: ["+z"],
      side: "new",
      start: 2,
      end: 2,
      kind: "keep",
      text: "no",
    });
    const raw = JSON.parse(disk.data.get("aos.diff-notes:envs/a") ?? "[]");
    expect(raw.map((n: Note) => n.path)).toEqual(["v.py", "w.py"]);
    expect(notesOf("envs/b")).toEqual([]);

    const [first, second] = notesOf("envs/a");
    removeNote("envs/a", first?.id ?? "");
    expect(notesOf("envs/a").map((n) => n.path)).toEqual(["w.py"]);
    clearSent("envs/a");
    expect(notesOf("envs/a")).toHaveLength(1);
    expect(second?.sent).toBeNull();

    disk.restore();
    disk = memoryStorage("local", { "aos.diff-notes:envs/c": "{not json" });
    expect(notesOf("envs/c")).toEqual([]);
  });

  test("sent notes older than a week go, and at most 200 stay", () => {
    const day = 24 * 3600 * 1000;
    const now = 30 * day;
    const list = [
      note({ id: "old", sent: now - 8 * day }),
      note({ id: "new", sent: now - day }),
      note({ id: "open" }),
    ];
    expect(prune(list, now).map((n) => n.id)).toEqual(["new", "open"]);
    const many = Array.from({ length: 205 }, (_, i) => note({ id: String(i) }));
    expect(prune(many, now).map((n) => n.id)[0]).toBe("5");
  });
});

test("the payload is what the server's schema takes: quotes without their marks", () => {
  const list = [note({ lines: ["-old", "+new"], text: "Mantén" }), note({ sent: 1 })];
  const body = payload(pendingOf(list));
  expect(body).toEqual([
    {
      path: "v.py",
      side: "new",
      start: 41,
      end: 41,
      quote: ["old", "new"],
      kind: "change",
      text: "Mantén",
    },
  ]);
  for (const n of body) expect(DiffNote.safeParse(n).success).toBe(true);
});
