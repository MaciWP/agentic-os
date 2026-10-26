import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { SERVER_ERRORS } from "./app-errors.ts";
import { answerFor, rule } from "./errors.ts";

class Parent extends Error {}
class Child extends Parent {}

test("the first matching rule answers; an unknown error has no answer", () => {
  const rules = [
    rule(Child, (e) => ({ status: 401, body: { error: "child", detail: e.message } })),
    rule(Parent, (e) => ({ status: 502, body: { error: "parent", detail: e.message } })),
  ];
  expect(answerFor(rules, new Child("c"))).toEqual({
    status: 401,
    body: { error: "child", detail: "c" },
  });
  expect(answerFor(rules, new Parent("p"))?.status).toBe(502);
  expect(answerFor(rules, new Error("x"))).toBeNull();
});

// A rule listed after its parent class would never answer.
test("no server rule is hidden behind an earlier one", () => {
  const hidden = SERVER_ERRORS.flatMap((later, j) =>
    SERVER_ERRORS.slice(0, j)
      .filter((earlier) => later.type.prototype instanceof earlier.type)
      .map((earlier) => `${later.type.name} after ${earlier.type.name}`),
  );
  expect(hidden).toEqual([]);
});

// SERVER_ERRORS is the one map from error to HTTP: a route that catches an error class and
// answers it itself is a second registry that can drift from the first.
test("no route answers an error class itself", () => {
  const ROOT = join(import.meta.dir, "..");
  const local = [...new Glob("server/features/**/routes.ts").scanSync(ROOT)]
    .sort()
    .flatMap((f) =>
      [
        ...readFileSync(join(ROOT, f), "utf8").matchAll(/instanceof (\w+)\)?\s*return c\.json\(/g),
      ].map((m) => `${f}: ${m[1]}`),
    );
  expect(local).toEqual([]);
});
