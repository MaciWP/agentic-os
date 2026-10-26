import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../db.ts";
import { KEEP_AUDIO, type Ports, type Settings, Transcripts } from "./runner.ts";
import { TranscriptStore } from "./store.ts";
import { writeWav } from "./test-wav.ts";

function setup(over: Partial<Ports> = {}, settings: Partial<Settings> = {}) {
  const root = mkdtempSync(join(tmpdir(), "transcripts-"));
  const db = openDb(":memory:");
  const calls = {
    decode: 0,
    vad: [] as string[],
    diarize: [] as unknown[],
    launched: [] as string[][],
  };
  let clock = Date.parse("2026-10-16T10:00:00Z");
  const ports: Ports = {
    decode: async () => `words ${++calls.decode}`,
    vad: async (wav) => {
      calls.vad.push(wav);
      return [{ start: 1, end: 3 }];
    },
    diarize: async (files, speakers) => {
      calls.diarize.push({ files, speakers });
      return [
        { start: 0, end: 5, speaker: 0 },
        { start: 5, end: 12, speaker: 1 },
      ];
    },
    alive: () => true,
    launch: async (argv) => {
      calls.launched.push(argv);
      return 0;
    },
    ...over,
  };
  const make = () =>
    new Transcripts(new TranscriptStore(db, () => new Date(clock)), ports, {
      root,
      app: "/data/bin/AgenticAudio.app",
      bundle: "com.microsoft.teams2",
      missing: () => null,
      pollMs: 1000,
      graceMs: 30_000,
      now: () => clock,
      id: () => "rec1",
      ...settings,
    });
  return { root, db, calls, make, transcripts: make(), tick: (ms: number) => (clock += ms) };
}

const state = (dir: string, s: object) => writeFileSync(join(dir, "state.json"), JSON.stringify(s));

test("start launches the helper by argv and stop writes the stop file", async () => {
  const { transcripts, calls, root } = setup();
  const rec = await transcripts.start({ speakers: 2 });
  expect(rec.status).toBe("recording");
  expect(calls.launched[0]).toEqual([
    "open",
    "-n",
    "-g",
    "/data/bin/AgenticAudio.app",
    "--args",
    "record",
    "--dir",
    join(root, "rec1"),
    "--bundle",
    "com.microsoft.teams2",
  ]);
  transcripts.stop("rec1");
  expect(existsSync(join(root, "rec1", "stop"))).toBe(true);
});

test("a second recording is refused while one runs; an unknown one cannot be stopped", async () => {
  const { transcripts } = setup();
  await transcripts.start({});
  expect(transcripts.start({})).rejects.toMatchObject({ code: "busy" });
  expect(() => transcripts.stop("missing")).toThrow("not found");
});

test("missing models or helper refuse the start with the reason", async () => {
  const { transcripts } = setup({}, { missing: () => "add transcripts.vad" });
  expect(transcripts.start({})).rejects.toMatchObject({
    status: 409,
    message: "add transcripts.vad",
  });
});

test("a helper that cannot be opened fails the recording", async () => {
  const { transcripts } = setup({ launch: async () => 1 });
  expect((await transcripts.start({})).status).toBe("failed");
  expect(transcripts.detail("rec1").error).toContain("exit 1");
});

test("a full recording goes recording → transcribing → diarizing → ready", async () => {
  const { transcripts, calls, root } = setup();
  await transcripts.start({ speakers: 2 });
  const dir = join(root, "rec1");
  state(dir, { status: "recording", pid: 1, warnings: ["mic_silent"] });
  writeWav(join(dir, "system", "000.wav"), 10);
  writeWav(join(dir, "system", "001.wav.part"), 3);
  writeWav(join(dir, "mic", "000.wav"), 10);
  await transcripts.poll();
  // The chunks closed so far are transcribed while recording goes on; the .part is left alone.
  expect(transcripts.list()[0]?.status).toBe("recording");
  expect(calls.vad.length).toBe(2);
  // Their text shows already, the system track as one "others" until the diarization.
  const live = transcripts.detail("rec1");
  expect(live.segments.map((s) => s.speaker)).toEqual(["me", "others"]);
  expect(live.progress).toEqual({ done: 2, total: 2 });
  expect(live.warnings).toEqual(["mic_silent"]);
  // The helper closes the last chunk and says it stopped.
  writeWav(join(dir, "system", "001.wav"), 6);
  state(dir, { status: "stopped", pid: 1 });
  await transcripts.poll();
  expect(calls.vad.length).toBe(3);
  expect(calls.diarize).toEqual([
    {
      files: [
        { path: join(dir, "system", "000.wav"), offset: 0 },
        { path: join(dir, "system", "001.wav"), offset: 10 },
      ],
      speakers: 2,
    },
  ]);
  const t = transcripts.detail("rec1");
  expect(t.status).toBe("ready");
  expect(t.labels).toEqual(["me", "Speaker 1", "Speaker 2"]);
  // The second system chunk's speech is at 1-3 s into it: 11-13 s in the recording.
  expect(t.segments.map((s) => [s.start, s.speaker])).toEqual([
    [1, "me"],
    [1, "Speaker 1"],
    [11, "Speaker 2"],
  ]);
  expect(t.markdown.split("\n")[2]).toMatch(/^\[00:00:11\] Speaker 2: words \d$/);
  // Only the text is kept: the audio is gone, the helper's state stays.
  expect(existsSync(join(dir, "system", "000.wav"))).toBe(false);
  expect(existsSync(join(dir, "mic", "000.wav"))).toBe(false);
  expect(existsSync(join(dir, "state.json"))).toBe(true);
  expect(t.warnings).toEqual([]);
});

test("the keep-audio file keeps the audio of the next long call, once", async () => {
  let n = 0;
  const { transcripts, root } = setup({}, { id: () => `rec${++n}`, keepAudioMinSeconds: 12 });
  writeFileSync(join(root, KEEP_AUDIO), "");
  const call = async (seconds: number[]) => {
    const rec = await transcripts.start({});
    for (const [i, s] of seconds.entries()) writeWav(join(rec.dir, "system", `00${i}.wav`), s);
    state(rec.dir, { status: "stopped", pid: 1 });
    await transcripts.poll();
    expect(transcripts.get(rec.id).status).toBe("ready");
    return existsSync(join(rec.dir, "system", "000.wav"));
  };
  // Too short to tune with: its audio goes and the file waits for the next call.
  expect(await call([5])).toBe(false);
  expect(existsSync(join(root, KEEP_AUDIO))).toBe(true);
  expect(await call([10, 6])).toBe(true);
  expect(existsSync(join(root, "rec2", KEEP_AUDIO))).toBe(true);
  expect(existsSync(join(root, KEEP_AUDIO))).toBe(false);
  expect(await call([10, 6])).toBe(false);
});

test("a restart keeps what was done and finishes the rest", async () => {
  const first = setup();
  await first.transcripts.start({});
  const dir = join(first.root, "rec1");
  state(dir, { status: "recording", pid: 1 });
  writeWav(join(dir, "system", "000.wav"), 10);
  await first.transcripts.poll();
  expect(first.calls.vad.length).toBe(1);
  // The server dies; the helper finishes meanwhile. A new instance on the same database and disk.
  state(dir, { status: "stopped", pid: 1 });
  writeWav(join(dir, "system", "001.wav"), 10);
  const reborn = first.make();
  await reborn.poll();
  expect(first.calls.vad.map((p) => p.slice(-7))).toEqual(["000.wav", "001.wav"]);
  expect(reborn.detail("rec1").status).toBe("ready");
});

test("a recording whose helper died without saying stopped moves on", async () => {
  const { transcripts, root } = setup({ alive: () => false });
  await transcripts.start({});
  const dir = join(root, "rec1");
  state(dir, { status: "recording", pid: 99 });
  writeWav(join(dir, "mic", "000.wav"), 5);
  await transcripts.poll();
  // No system track: nothing to diarize.
  expect(transcripts.detail("rec1").status).toBe("ready");
});

test("the helper's failure, or no helper at all, fails the recording", async () => {
  const a = setup();
  await a.transcripts.start({});
  state(join(a.root, "rec1"), { status: "failed", error: "no permission" });
  await a.transcripts.poll();
  expect(a.transcripts.detail("rec1")).toMatchObject({ status: "failed", error: "no permission" });

  const b = setup();
  await b.transcripts.start({});
  await b.transcripts.poll();
  expect(b.transcripts.list()[0]?.status).toBe("recording");
  b.tick(31_000);
  await b.transcripts.poll();
  expect(b.transcripts.detail("rec1").error).toContain("did not start");
  // A helper that starts late finds the stop file and ends.
  expect(existsSync(join(b.root, "rec1", "stop"))).toBe(true);
});

test("a step that throws fails the recording with its message", async () => {
  const { transcripts, root } = setup({
    diarize: async () => {
      throw new Error("diarize failed (1): boom");
    },
  });
  await transcripts.start({});
  const dir = join(root, "rec1");
  state(dir, { status: "stopped" });
  writeWav(join(dir, "system", "000.wav"), 5);
  await transcripts.poll();
  expect(transcripts.detail("rec1")).toMatchObject({
    status: "failed",
    error: "diarize failed (1): boom",
  });
});

test("a recording joins the calendar meeting it overlaps, also when the sync comes later", async () => {
  const { transcripts, db, tick } = setup();
  const rec = await transcripts.start({});
  const meeting = (start: string, end: string, allDay = 0) =>
    db.run(
      `INSERT INTO meetings (source, event_key, title, starts_at, ends_at, all_day)
       VALUES ('outlook', ?, 'Daily', ?, ?, ?)`,
      [start, start, end, allDay],
    );
  // Started at 10:00: an all-day event and one that ended before never match.
  meeting("2026-10-16T00:00:00.000Z", "2026-10-17T00:00:00.000Z", 1);
  meeting("2026-10-16T09:00:00.000Z", "2026-10-16T09:30:00.000Z");
  meeting("2026-10-16T10:05:00.000Z", "2026-10-16T10:30:00.000Z");
  tick(1000);
  await transcripts.poll();
  const linked = transcripts.list().find((r) => r.id === rec.id);
  const id = db
    .query<{ id: number }, []>(
      "SELECT id FROM meetings WHERE title = 'Daily' AND starts_at LIKE '%T10:05%'",
    )
    .get()?.id;
  expect(linked?.meetingId).toBe(id ?? -1);
});
