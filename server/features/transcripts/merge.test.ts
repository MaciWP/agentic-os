import { expect, test } from "bun:test";
import { markdown, mergeTracks, speakerAt, stamp } from "./merge.ts";
import { decodePlan } from "./plan.ts";

const turns = [
  { start: 0, end: 10, speaker: 0 },
  { start: 10, end: 20, speaker: 1 },
];

test("the speaker with most overlap talks; with none, the nearest turn", () => {
  expect(speakerAt(turns, { start: 8, end: 14, text: "" })).toBe(1);
  expect(speakerAt(turns, { start: 30, end: 31, text: "" })).toBe(1);
  expect(speakerAt([], { start: 0, end: 1, text: "" })).toBeNull();
});

test("the markdown has the time, the speaker and the text, microphone as me", () => {
  const segments = mergeTracks(
    [{ start: 11, end: 12, text: "sounds good" }],
    [
      { start: 1, end: 4, text: "hello team" },
      { start: 3700, end: 3702, text: "bye" },
    ],
    [...turns, { start: 3690, end: 3710, speaker: 0 }],
  );
  expect(markdown(segments)).toBe(
    [
      "[00:00:01] Speaker 1: hello team",
      "[00:00:11] me: sounds good",
      "[01:01:40] Speaker 1: bye",
    ].join("\n"),
  );
});

test("a name the user gave replaces the label, me included", () => {
  const segments = mergeTracks(
    [{ start: 0, end: 1, text: "hi" }],
    [{ start: 2, end: 3, text: "hello" }],
    turns,
    { "Speaker 1": "Ana", me: "Oriol" },
  );
  expect(segments.map((s) => s.speaker)).toEqual(["Oriol", "Ana"]);
});

test("hours do not wrap at a day", () => {
  expect(stamp(26 * 3600 + 61)).toBe("26:01:01");
});

test("ranges under a second join a neighbour or widen", () => {
  expect(
    decodePlan(
      [
        { start: 0, end: 3 },
        { start: 3.5, end: 3.9 },
      ],
      60,
    ),
  ).toEqual([{ start: 0, end: 3.9 }]);
  const [alone] = decodePlan([{ start: 30, end: 30.4 }], 60);
  expect((alone?.end ?? 0) - (alone?.start ?? 0)).toBeCloseTo(1);
  expect(decodePlan([{ start: 59.9, end: 60 }], 60)[0]?.end).toBe(60);
});
