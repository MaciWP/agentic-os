import { expect, test } from "bun:test";
import { foldCrumbs, relabel, SpeakerLinker } from "./link.ts";

const A = [1, 0, 0];
const B = [0, 1, 0];
const C = [0, 0, 1];
const near = (v: number[]) => v.map((x, i) => x + (i === 2 ? 0.05 : 0));

test("a speaker keeps one id across blocks even when each block numbers its own", () => {
  const linker = new SpeakerLinker(0.5);
  expect(linker.link([A, B])).toEqual([0, 1]);
  // The next block lists them the other way round, with a third voice.
  expect(linker.link([near(B), C, near(A)])).toEqual([1, 2, 0]);
  expect(linker.size).toBe(3);
});

test("two speakers of one block never share a global speaker", () => {
  const linker = new SpeakerLinker(0.1);
  linker.link([A]);
  const ids = linker.link([A, near(A)]);
  expect(new Set(ids).size).toBe(2);
});

test("a known count merges the closest speakers", () => {
  const linker = new SpeakerLinker(0.9);
  linker.link([A, near(A), B]);
  const into = linker.mergeDown(2);
  expect(into[0]).toBe(into[1]);
  expect(into[2]).not.toBe(into[0]);
});

test("a speaker with a few seconds joins the closest voice that talks long enough", () => {
  // 0 and 2 talk for minutes; 1 and 3 are crumbs, 1 sounds like 2, 3 like 0.
  expect(foldCrumbs([A, near(B), B, near(A)], [300, 4, 120, 19], 20)).toEqual([0, 2, 2, 0]);
  // A block where nobody talks long enough keeps everyone.
  expect(foldCrumbs([A, B], [5, 8], 20)).toEqual([0, 1]);
});

test("speakers are renumbered by who talks first", () => {
  const turns = [
    { start: 5, end: 6, speaker: 2 },
    { start: 0, end: 1, speaker: 7 },
    { start: 8, end: 9, speaker: 7 },
  ];
  expect(relabel(turns).map((t) => t.speaker)).toEqual([0, 1, 0]);
});
