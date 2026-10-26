import { describe, expect, test } from "bun:test";
import { rms, silentFrame, toPcm16 } from "./capture.ts";

describe("capture", () => {
  test("frames join into 16-bit PCM, clipped at full scale", () => {
    const pcm = toPcm16([Float32Array.of(0, 0.5, -0.5), Float32Array.of(1, -1, 2, -2)]);
    expect([...pcm]).toEqual([0, 16383, -16384, 32767, -32768, 32767, -32768]);
  });

  test("the level is the frame's RMS; an empty frame is silence", () => {
    expect(rms(Float32Array.of(0.5, -0.5))).toBeCloseTo(0.5);
    expect(rms(new Float32Array(0))).toBe(0);
  });

  test("only exact zeros count as a microphone not delivering yet; a quiet room does not", () => {
    expect(silentFrame(new Float32Array(128))).toBe(true);
    expect(silentFrame(Float32Array.of(0, 0, 0.00003))).toBe(false);
  });
});
