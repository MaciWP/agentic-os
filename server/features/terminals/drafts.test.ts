import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../app.ts";
import { ConfigSchema } from "../../config.ts";
import { openDb } from "../../db.ts";
import type { GithubClient } from "../github/prs.ts";
import type { Client, TerminalInfo, Terminals } from "./contract.ts";
import { Drafts, MAX_DRAFT_IMAGES } from "./drafts.ts";
import { AttachTokens } from "./ws-guard.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const png = (n: number) => ({ n, image: { mime: "image/png", data: PNG.toString("base64") } });

const info = (id: string, over: Partial<TerminalInfo> = {}) =>
  ({ id, harness: "claude", cwd: "/work", state: "running", ...over }) as TerminalInfo;

describe("draft images from the hud mod", () => {
  const dir = mkdtempSync(join(tmpdir(), "aos-drafts-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const list = [
    info("cl"),
    info("other"),
    info("sh", { harness: "shell" }),
    info("gone", { state: "exited" }),
  ];
  const terminals = {
    subscribe: () => () => {},
    list: () => list,
    get: (id: string) => list.find((t) => t.id === id),
  } as unknown as Terminals;
  const app = createApp({
    config: ConfigSchema.parse({ repos: [] }),
    db: openDb(":memory:"),
    terminals,
    tokens: new AttachTokens(),
    github: {} as GithubClient,
    memoryRoots: { home: join(dir, "home"), dataDir: join(dir, "data"), repos: [] },
    pastesDir: join(dir, "pastes"),
  });
  const post = (id: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(`/api/terminals/${id}/drafts`, {
      method: "POST",
      headers: {
        host: "127.0.0.1:4317",
        origin: "http://127.0.0.1:4317",
        "content-type": "application/json",
        "x-aos-agent-id": id,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const image = (id: string, n: number) =>
    app.request(`/api/terminals/${id}/drafts/${n}`, { headers: { host: "127.0.0.1:4317" } });

  test("the terminal's own session sets its images, served with the history's headers", async () => {
    expect((await post("cl", { images: [png(1), png(3)] })).status).toBe(200);
    const res = await image("cl", 3);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(PNG));
    expect((await image("cl", 2)).status).toBe(404);
    // An empty list clears the draft.
    expect((await post("cl", { images: [] })).status).toBe(200);
    expect((await image("cl", 1)).status).toBe(404);
  });

  test("another terminal, a shell, an exited one or no identity are refused", async () => {
    expect((await post("cl", { images: [png(1)] }, { "x-aos-agent-id": "other" })).status).toBe(
      403,
    );
    expect((await post("sh", { images: [png(1)] })).status).toBe(403);
    expect((await post("gone", { images: [png(1)] })).status).toBe(403);
    expect((await post("cl", { images: [png(1)] }, { "x-aos-agent-id": "" })).status).toBe(403);
    // The local guard stays in front: no browser origin, no write.
    expect(
      (await post("cl", { images: [png(1)] }, { origin: "https://evil.example" })).status,
    ).toBe(403);
  });

  test("bytes that are not the format claimed, too many images or a bad number are refused", async () => {
    const fake = {
      n: 1,
      image: { mime: "image/png", data: Buffer.from("GIF89a....").toString("base64") },
    };
    expect((await post("cl", { images: [fake] })).status).toBe(400);
    const many = Array.from({ length: MAX_DRAFT_IMAGES + 1 }, (_, i) => png(i + 1));
    expect((await post("cl", { images: many })).status).toBe(400);
    expect((await post("cl", { images: [png(0)] })).status).toBe(400);
    expect((await post("cl", { images: [{ ...png(1), path: "/etc/passwd" }] })).status).toBe(400);
  });
});

describe("Drafts", () => {
  const client = () => {
    const sent: string[] = [];
    return {
      sent,
      client: {
        send: (m: string) => sent.push(m),
        close: () => {},
        isOpen: () => true,
        bufferedAmount: () => 0,
      } as Client,
    };
  };
  const body = (...ns: number[]) => ({
    images: ns.map((n) => ({
      n,
      image: { mime: "image/png" as const, data: PNG.toString("base64") },
    })),
  });

  test("a window hears the list on joining and on every change, and nothing after leaving", () => {
    const drafts = new Drafts();
    const a = client();
    drafts.set("t", body(1));
    drafts.join("t", a.client);
    drafts.set("t", body(1, 2));
    expect(a.sent.map((m) => JSON.parse(m).images.map((i: { n: number }) => i.n))).toEqual([
      [1],
      [1, 2],
    ]);
    // Each image carries a version, so a window reloads a number whose bytes changed.
    const [first, second] = a.sent.map((m) => JSON.parse(m).images[0].v);
    expect(second).toBeGreaterThan(first);
    // And its size, for the badge under the thumbnail.
    expect(JSON.parse(a.sent[0] ?? "").images[0].size).toBe(PNG.length);
    drafts.leave("t", a.client);
    drafts.clear("t");
    expect(a.sent).toHaveLength(2);
    expect(drafts.get("t", 1)).toBeUndefined();
  });
});
