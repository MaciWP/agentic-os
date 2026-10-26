import { afterEach, expect, test } from "bun:test";
import { memoryStorage } from "../../test-storage.ts";
import { appendDraft, draftOf, draftTranscriptions, setDraft } from "./composer.tsx";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("a dictation goes after what is written, one space apart, and an empty draft is removed", () => {
  const disk = memoryStorage("local");
  try {
    expect(appendDraft("t1", "hola ")).toBe(true);
    expect(draftOf("t1")).toBe("hola ");
    appendDraft("t1", "mundo ");
    expect(draftOf("t1")).toBe("hola mundo ");
    setDraft("t1", "revisa");
    appendDraft("t1", "el login ");
    expect(disk.data.get("aos.terminal.draft:t1")).toBe("revisa el login ");
    // The agent's coordination draft is another key.
    expect(disk.data.has("aos.message.draft:t1")).toBe(false);
    setDraft("t1", "");
    expect(disk.data.size).toBe(0);
  } finally {
    disk.restore();
  }
});

test("a phone dictation lands in the draft and never types into the terminal", async () => {
  const disk = memoryStorage("local");
  const posts: string[] = [];
  globalThis.fetch = (async (path: string) => {
    posts.push(path);
    return Response.json({ text: "hola" });
  }) as typeof fetch;
  try {
    setDraft("t2", "ya escrito");
    const result = await draftTranscriptions.transcribe("t2", new Int16Array(160));
    expect(result).toEqual({ outcome: "done", text: "hola" });
    // Kept on disk, so the draft is there when the composer opens again, after a reload too.
    expect(disk.data.get("aos.terminal.draft:t2")).toBe("ya escrito hola ");
    expect(posts).toEqual(["/api/voice/transcribe"]);
  } finally {
    disk.restore();
  }
});
