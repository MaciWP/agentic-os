import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import { log } from "./log.ts";

// What a known failure answers: its HTTP status and the JSON body the client reads.
export type ErrorAnswer = {
  status: ContentfulStatusCode;
  body: { error: string; detail: string; [key: string]: unknown };
};

// One error class and its answer. Rules are tried in order, so a subclass comes before its
// parent. This file imports no feature, so the PTY host can keep its own list of rules.
export type ErrorRule = {
  type: abstract new (...args: never[]) => Error;
  answer: (err: Error) => ErrorAnswer;
};

export const rule = <E extends Error>(
  type: abstract new (...args: never[]) => E,
  answer: (err: E) => ErrorAnswer,
): ErrorRule => ({ type, answer: (err) => answer(err as E) });

// The answer of a failure that carries its own code and status.
export const coded = (err: { code: string; message: string; status: ErrorAnswer["status"] }) => ({
  status: err.status,
  body: { error: err.code, detail: err.message },
});

// The answer of the first rule whose class `err` is, or null.
export function answerFor(rules: readonly ErrorRule[], err: Error): ErrorAnswer | null {
  return rules.find((r) => err instanceof r.type)?.answer(err) ?? null;
}

// An app's onError. A known failure gets its rule's answer. Failed validation and anything
// else get a generic 500; the cause stays in the server log, found by the request ID.
export function errorHandler(rules: readonly ErrorRule[], scope = "http") {
  return (err: Error, c: Context) => {
    const known = answerFor(rules, err);
    if (known) return c.json(known.body, known.status);
    const request = c.res.headers.get("x-request-id");
    if (err instanceof ZodError) {
      // The paths and messages of what failed, never the values: they can be stored data.
      const issues = err.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`);
      log(scope).error("data_shape", { request, issues: issues.join("; ") });
      return c.json(
        {
          error: "data_shape",
          detail: "Stored or internal data failed validation. See the request ID.",
        },
        500,
      );
    }
    log(scope).error("internal", { request, err });
    return c.json(
      { error: "internal", detail: "Unexpected server failure. See the request ID." },
      500,
    );
  };
}
