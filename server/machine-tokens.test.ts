import { expect, test } from "bun:test";
import { tokenStore } from "./machine-tokens.ts";

const keychain = (initial: string | null = null) => {
  const s = { value: initial, reads: 0, writes: 0, fail: false };
  return {
    s,
    secrets: {
      get: async () => {
        s.reads++;
        if (s.fail) throw new Error("keychain locked");
        return s.value;
      },
      set: async (value: string) => {
        s.writes++;
        s.value = value;
      },
    },
  };
};

test("the Keychain is read once, however often a token is asked for", async () => {
  const { s, secrets } = keychain(JSON.stringify({ win: "t1" }));
  const tokens = tokenStore(secrets);
  const got = await Promise.all([tokens.get("win"), tokens.get("win"), tokens.get("other")]);
  expect(got).toEqual(["t1", "t1", null]);
  for (let i = 0; i < 10; i++) await tokens.get("win");
  expect(s.reads).toBe(1);
});

test("a set is kept and stored, with the other machines' tokens", async () => {
  const { s, secrets } = keychain(JSON.stringify({ win: "t1" }));
  const tokens = tokenStore(secrets);
  await tokens.set("lab", "t2");
  expect(JSON.parse(s.value as string)).toEqual({ win: "t1", lab: "t2" });
  expect(await tokens.get("lab")).toBe("t2");
  await tokens.set("win", "t3");
  expect(await tokens.get("win")).toBe("t3");
  expect(s.reads).toBe(1);
});

test("a missing item is read again, so a later pairing is seen", async () => {
  const { s, secrets } = keychain(null);
  const tokens = tokenStore(secrets);
  expect(await tokens.get("win")).toBeNull();
  s.value = JSON.stringify({ win: "t1" });
  expect(await tokens.get("win")).toBe("t1");
  expect(await tokens.get("win")).toBe("t1");
  expect(s.reads).toBe(2);
});

test("a failed read is not kept", async () => {
  const { s, secrets } = keychain(JSON.stringify({ win: "t1" }));
  const tokens = tokenStore(secrets);
  s.fail = true;
  await expect(tokens.get("win")).rejects.toThrow("keychain locked");
  s.fail = false;
  expect(await tokens.get("win")).toBe("t1");
});

test("a malformed item reads as no tokens", async () => {
  const { secrets } = keychain("not json");
  expect(await tokenStore(secrets).get("win")).toBeNull();
});
