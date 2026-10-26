import { dlopen, FFIType, ptr } from "bun:ffi";

// A process's physical footprint, the memory Activity Monitor shows. ps's RSS leaves out what
// macOS has compressed or swapped: the loaded voice model reads 43 MB of RSS for 1.2 GB of
// footprint. Read in-process with proc_pid_rusage, under a microsecond a pid, so the 5 s poll
// spawns nothing for it. null when it cannot be read (another user's process, gone, not macOS).

// rusage_info_v0 (<sys/resource.h>): a 16-byte uuid, then u64 fields, the 9th of them (word 9)
// ri_phys_footprint. Word 8, ri_resident_size, matched ps's RSS to the KB when checked.
const RUSAGE_INFO_V0 = 0;
const FOOTPRINT = 9;
const words = new BigUint64Array(12);

let rusage: ((pid: number) => boolean) | null | undefined;

function load() {
  if (process.platform !== "darwin") return null;
  const lib = dlopen("/usr/lib/libSystem.B.dylib", {
    proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  });
  return (pid: number) => lib.symbols.proc_pid_rusage(pid, RUSAGE_INFO_V0, ptr(words)) === 0;
}

export function footprintKb(pid: number): number | null {
  rusage ??= load();
  return rusage?.(pid) ? Math.round(Number(words[FOOTPRINT]) / 1024) : null;
}
