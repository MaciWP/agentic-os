import { afterEach, describe, expect, test } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";
import type { MailInbox } from "../../../shared/mail-inbox.ts";
import { failQuery, renderWith } from "../../test-render.tsx";
import { memoryStorage } from "../../test-storage.ts";
import { Section } from "./parts.tsx";
import { useMail } from "./queries.ts";

const KEY = "aos.inicio.mail.gmail";
const inbox = (subject: string): MailInbox => ({
  threads: [
    {
      id: "t1",
      subject,
      from: "Ana",
      at: "2026-10-23T08:00:00Z",
      snippet: "",
      messages: 1,
      unread: true,
      starred: false,
      link: "https://mail.google.com/",
    },
  ],
  total: 1,
});

function Probe() {
  const q = useMail();
  return (
    <Section title="Personal" q={q} count={() => ""}>
      {(d) => <p>{d.threads[0]?.subject}</p>}
    </Section>
  );
}

const realFetch = globalThis.fetch;
let storage = memoryStorage("local");
afterEach(() => {
  globalThis.fetch = realFetch;
  storage.restore();
});

describe("the inbox this browser kept", () => {
  test("a reopened page draws it before any read answers", async () => {
    storage = memoryStorage("local", { [KEY]: JSON.stringify(inbox("Guardado")) });
    globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
    expect(await renderWith(<Probe />)).toContain("Guardado");
  });

  test("a read that works replaces it; a provider turned off is never kept", async () => {
    storage = memoryStorage("local");
    let answer: unknown = inbox("Nuevo");
    globalThis.fetch = (async () => Response.json(answer)) as unknown as typeof fetch;
    let client: QueryClient | undefined;
    await renderWith(<Probe />, [], (c) => {
      client = c;
    });
    // The query as the page built it; with no observer left, it is read by hand.
    const read = () =>
      client
        ?.getQueryCache()
        .find({ queryKey: ["google", "inbox"] })
        ?.fetch();
    await read();
    expect(JSON.parse(storage.data.get(KEY) ?? "null")).toEqual(inbox("Nuevo"));
    answer = { disabled: true };
    await read();
    expect(JSON.parse(storage.data.get(KEY) ?? "null")).toEqual(inbox("Nuevo"));
  });

  test("a read that fails shows the failure, never the kept list", async () => {
    storage = memoryStorage("local", { [KEY]: JSON.stringify(inbox("Guardado")) });
    const html = await renderWith(
      <Probe />,
      [],
      failQuery(["google", "inbox"], inbox("Guardado"), "Gmail down"),
    );
    expect(html).toContain("Reintentar");
    expect(html).not.toContain("Guardado");
  });
});
