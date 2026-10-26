import { expect, test } from "bun:test";
import path from "node:path";
import { hasGitSegment, isInside, samePath } from "./paths.ts";

test("a folder holds itself and what is below it, nothing else", () => {
  expect(isInside("/a/b", "/a/b")).toBe(true);
  expect(isInside("/a/b", "/a/b/")).toBe(true);
  expect(isInside("/a/b", "/a/b/c/d.txt")).toBe(true);
  expect(isInside("/a/b", "/a/bc")).toBe(false);
  expect(isInside("/a/b", "/a")).toBe(false);
  expect(isInside("/a/b", "/x/y")).toBe(false);
  expect(isInside("/a/b", "/a/b/../c")).toBe(false);
});

test("a name that starts with two dots is still inside", () => {
  expect(isInside("/a/b", "/a/b/..cache")).toBe(true);
});

test("a relative or empty path is never inside, whatever the server's folder", () => {
  expect(isInside("/", "")).toBe(false);
  expect(isInside("/", "a/b")).toBe(false);
  expect(isInside("", "/a/b")).toBe(false);
});

test("on Windows, a folder holds what is below it whatever the case or separator", () => {
  const w = path.win32;
  expect(isInside("D:\\PYTHON", "D:\\PYTHON\\repo\\a.py", w)).toBe(true);
  expect(isInside("D:\\PYTHON", "d:/python/repo", w)).toBe(true);
  expect(isInside("D:\\PYTHON\\repo", "D:\\PYTHON\\repo\\..\\other", w)).toBe(false);
  expect(isInside("D:\\PYTHON", "D:\\PYTHONX", w)).toBe(false);
  expect(isInside("D:\\PYTHON", "C:\\PYTHON\\repo", w)).toBe(false);
  expect(isInside("D:\\PYTHON", "repo\\a.py", w)).toBe(false);
});

test("one place has one answer: case and separators count only where the file system says", () => {
  const w = path.win32;
  expect(samePath("D:\\Python\\repo", "d:/PYTHON/repo/", w)).toBe(true);
  expect(samePath("D:\\Python\\repo", "D:\\Python\\repo2", w)).toBe(false);
  expect(samePath("C:\\x", "D:\\x", w)).toBe(false);
  expect(samePath("/a/b", "/a/b/", path.posix)).toBe(true);
  expect(samePath("/a/b", "/a/B", path.posix)).toBe(false);
  expect(samePath("", "/a", path.posix)).toBe(false);
});

test("git's folder is found under any spelling a file system accepts", () => {
  for (const p of [
    ".git/config",
    "a\\.git\\HEAD",
    ".GIT/config",
    "a/.Git/x",
    ".git./x",
    ".git /x",
    ".git::$DATA",
    "a/.git",
  ])
    expect(hasGitSegment(p)).toBe(true);
  for (const p of ["src/a.ts", ".github/workflows/ci.yml", ".gitignore", "a/b.git/c", "git/x"])
    expect(hasGitSegment(p)).toBe(false);
});
