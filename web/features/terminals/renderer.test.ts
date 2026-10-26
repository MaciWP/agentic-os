import { expect, test } from "bun:test";
import { memoryStorage } from "../../test-storage.ts";
import { softwareGl, storedChoice, wantsGpu } from "./renderer.ts";

test("a GPU emulated on the CPU keeps the DOM renderer; a real one draws", () => {
  for (const soft of [
    "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
    "llvmpipe (LLVM 15.0.7, 256 bits)",
    "ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)",
  ])
    expect(softwareGl(soft)).toBe(true);
  for (const real of [
    "ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)",
    "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x0000A7A0) Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "Adreno (TM) 740",
  ])
    expect(softwareGl(real)).toBe(false);
});

test("the stored choice: auto unless the browser asked for the GPU or the CPU", () => {
  for (const [raw, choice] of [
    [undefined, "auto"],
    ["dom", "dom"],
    ["gpu", "gpu"],
    ["webgl", "auto"],
  ] as const) {
    const disk = memoryStorage("local", raw ? { "aos.terminal-renderer": raw } : {});
    expect(storedChoice.get()).toBe(choice);
    disk.restore();
  }
});

test("a choice kept under the old unprefixed name moves to the new one", () => {
  const disk = memoryStorage("local", { "terminal-renderer": "dom" });
  expect(storedChoice.get()).toBe("dom");
  expect(Object.fromEntries(disk.data)).toEqual({ "aos.terminal-renderer": "dom" });
  disk.restore();
});

test("auto draws on a real GPU only; forced GPU on any WebGL2; CPU never", () => {
  const real = "ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)";
  const soft = "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)";
  expect(wantsGpu("auto", real)).toBe(true);
  expect(wantsGpu("auto", soft)).toBe(false);
  expect(wantsGpu("gpu", soft)).toBe(true);
  expect(wantsGpu("dom", real)).toBe(false);
  for (const choice of ["auto", "gpu", "dom"] as const) expect(wantsGpu(choice, null)).toBe(false);
});
