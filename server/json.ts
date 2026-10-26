// A JSON line or file written by another program, or null when it is not JSON (a line cut
// mid-write, a file being rewritten): readers skip it instead of failing.
export const jsonOrNull = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
