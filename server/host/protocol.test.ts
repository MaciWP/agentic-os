import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { z } from "zod";
import * as wire from "../../shared/host-contract.ts";

// Every protocol the host has spoken, with the hash of its wire shapes. A change to the shapes
// fails here until it gets a new entry, and a new entry needs a new PROTOCOL: a server never
// talks to a host whose shapes differ under the same number.
const HISTORY = [{ protocol: 10, hash: "ea890db52ec78489" }];

// The shapes as JSON Schema, plus the frames and limits; refinements and transforms are not
// representable, so a change to one of those alone needs a manual bump.
function contractHash(): string {
  const shapes: Record<string, unknown> = { ...wire };
  const flat = Object.keys(shapes)
    .sort()
    .filter((k) => k !== "PROTOCOL")
    .map((k) => {
      const v = shapes[k];
      return [k, v instanceof z.ZodType ? z.toJSONSchema(v, { unrepresentable: "any" }) : v];
    });
  return createHash("sha256").update(JSON.stringify(flat)).digest("hex").slice(0, 16);
}

test("PROTOCOL changes whenever the host's wire shapes do", () => {
  expect(HISTORY.at(-1)).toEqual({ protocol: wire.PROTOCOL, hash: contractHash() });
  expect(new Set(HISTORY.map((h) => h.protocol)).size).toBe(HISTORY.length);
  expect(new Set(HISTORY.map((h) => h.hash)).size).toBe(HISTORY.length);
});
