import { expect, test } from "bun:test";
import http from "node:http";
import { IDLE_TIMEOUT_S, within } from "./deadline.ts";

// A Node client, as Playwright's request API is, against a handler silent for 14 s.
function get(port: number): Promise<number | string> {
  return new Promise((resolve) => {
    http
      .get(`http://127.0.0.1:${port}/`, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      })
      .on("error", (err) => resolve((err as NodeJS.ErrnoException).code ?? err.message));
  });
}

test("Bun resets a request silent for 10 s by default (about 12 s in practice); the server's idle timeout lets it answer", async () => {
  const slow = async () => {
    await Bun.sleep(14_000);
    return new Response("ok");
  };
  const plain = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: slow });
  const ours = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: IDLE_TIMEOUT_S,
    fetch: slow,
  });
  try {
    const [cut, answered] = await Promise.all([get(plain.port ?? 0), get(ours.port ?? 0)]);
    expect(cut).toBe("ECONNRESET");
    expect(answered).toBe(200);
  } finally {
    plain.stop(true);
    ours.stop(true);
  }
}, 20_000);

test("a caller stops waiting at its deadline; the shared promise still settles for others", async () => {
  let settle = (_: string) => {};
  const shared = new Promise<string>((r) => {
    settle = r;
  });
  const late = within(shared, AbortSignal.timeout(20));
  expect(late).rejects.toMatchObject({ name: "TimeoutError" });
  await late.catch(() => {});
  const patient = within(shared);
  settle("token");
  expect(await patient).toBe("token");
  expect(await within(Promise.resolve(1), AbortSignal.timeout(1000))).toBe(1);
});
