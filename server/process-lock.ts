import { dlopen, FFIType } from "bun:ffi";
import { closeSync, openSync } from "node:fs";

// The kernel releases this lock on exit/crash. Never unlink the file: removing its
// inode would allow another process to lock a different inode under the same name.
export function acquireProcessLock(path: string): (() => void) | null {
  if (process.platform === "win32") return acquireWindowsLock(path);
  const libc = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
  const lib = dlopen(libc, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
  let fd: number;
  try {
    fd = openSync(path, "a", 0o600);
  } catch (err) {
    lib.close();
    throw err;
  }
  if (lib.symbols.flock(fd, 2 | 4) !== 0) {
    closeSync(fd);
    lib.close();
    return null;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lib.symbols.flock(fd, 8);
    closeSync(fd);
    lib.close();
  };
}

const GENERIC_READ_WRITE = 0x80000000 | 0x40000000;
const OPEN_ALWAYS = 4;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const INVALID_HANDLE = -1;

// Windows: a handle opened with no sharing is the lock. Any other open of the file fails
// with a sharing violation until this process closes it or ends.
function acquireWindowsLock(path: string): (() => void) | null {
  const lib = dlopen("kernel32.dll", {
    CreateFileW: {
      args: [
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
      ],
      returns: FFIType.i64,
    },
    CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
  });
  const name = Buffer.from(`${path}\0`, "utf16le");
  const handle = lib.symbols.CreateFileW(
    name,
    GENERIC_READ_WRITE,
    0,
    null,
    OPEN_ALWAYS,
    FILE_ATTRIBUTE_NORMAL,
    null,
  );
  if (Number(handle) === INVALID_HANDLE) {
    lib.close();
    // Busy only when someone holds it; a missing folder or a denied path is an error.
    try {
      closeSync(openSync(path, "a"));
    } catch (err) {
      if (["EBUSY", "EPERM", "EACCES"].includes((err as NodeJS.ErrnoException).code ?? ""))
        return null;
      throw err;
    }
    return null;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lib.symbols.CloseHandle(handle);
    lib.close();
  };
}
