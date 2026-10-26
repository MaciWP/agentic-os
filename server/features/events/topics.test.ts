import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { TOPICS } from "../../../shared/events.ts";
import { APP_ROOT } from "../../config.ts";

// Every topic needs a server side that announces it and a query the browser reads again: a
// topic with no producer never fires, and one with no consumer costs a timer or a watcher for
// nothing. A text match, not a parser: a producer is `publish("t")` or a bus entry
// `topic: "t"`; a consumer is a query key that starts with `["t"`.
function shipped(dir: string): string[] {
  return [...new Glob("**/*.{ts,tsx}").scanSync(join(APP_ROOT, dir))]
    .filter((f) => !/\.(test|e2e)\.tsx?$/.test(f))
    .map((f) => readFileSync(join(APP_ROOT, dir, f), "utf8"));
}

test("every event topic has a producer on the server and a consumer in the web", () => {
  const server = shipped("server").join("\n");
  const web = shipped("web").join("\n");
  const orphans = TOPICS.flatMap((t) => {
    const missing: string[] = [];
    if (!server.includes(`publish("${t}")`) && !server.includes(`topic: "${t}"`))
      missing.push(`${t}: no producer`);
    if (!web.includes(`["${t}"`)) missing.push(`${t}: no consumer`);
    return missing;
  });
  expect(orphans).toEqual([]);
});
