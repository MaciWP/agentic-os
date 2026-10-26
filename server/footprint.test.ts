import { expect, test } from "bun:test";
import { footprintKb } from "./footprint.ts";

// A child that fills 200 MB and waits: its footprint holds them, whatever macOS later compresses.
const FILL = `const b = new Uint8Array(200 * 1024 * 1024); for (let i = 0; i < b.length; i += 4096) b[i] = 1;
console.log("ready"); await Bun.sleep(30_000); console.log(b[0]);`;

test.skipIf(process.platform !== "darwin")(
  "a process's footprint counts the memory it filled",
  async () => {
    const child = Bun.spawn([process.execPath, "-e", FILL], { stdout: "pipe", stderr: "inherit" });
    try {
      const reader = child.stdout.getReader();
      await reader.read();
      reader.releaseLock();
      const kb = footprintKb(child.pid);
      expect(kb).toBeGreaterThan(200 * 1024);
      // Within reach of the fill plus a Bun runtime, so the field read is the footprint.
      expect(kb).toBeLessThan(600 * 1024);
    } finally {
      child.kill();
    }
  },
);

test.skipIf(process.platform !== "darwin")(
  "a process that is gone, or not ours, reads as null",
  () => {
    expect(footprintKb(999_999)).toBeNull();
    expect(footprintKb(1)).toBeNull();
  },
);
