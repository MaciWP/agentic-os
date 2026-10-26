import { describe, expect, test } from "bun:test";
import type { MailProfile } from "../../../server/features/google/client.ts";
import { ApiError } from "../../api.ts";
import { renderWith } from "../../test-render.tsx";
import { CleanupView } from "./cleanup.tsx";
import { Section } from "./parts.tsx";
import { ThreadView } from "./thread.tsx";

const read = <T,>(over: object) => ({
  isPending: false,
  isError: false,
  error: null,
  data: undefined as T | undefined,
  refetch: () => {},
  ...over,
});

describe("Hoy sections", () => {
  const body = () => <p>cuerpo</p>;

  test("a Google reconnect error asks to connect Google, not Jira", async () => {
    const error = new ApiError(401, "reconnect_required", "not connected", "google");
    const html = await renderWith(
      <Section title="Agenda" q={read({ isError: true, error })} count={() => ""}>
        {body}
      </Section>,
    );
    expect(html).toContain("Google necesita conectarse");
    expect(html).not.toContain("Jira");
    expect(html).not.toContain("cuerpo");
  });

  test("a disabled provider says so instead of an empty list", async () => {
    const html = await renderWith(
      <Section title="Correo" q={read({ data: { disabled: true } })} count={() => ""}>
        {body}
      </Section>,
    );
    expect(html).toContain("Google está desactivado");
    expect(html).not.toContain("cuerpo");
  });
});

describe("reading panel", () => {
  const full = {
    id: "a1",
    subject: "Factura",
    link: "https://mail.example/a1",
    messages: [
      {
        id: "m1",
        from: "Ana <ana@x.com>",
        to: "me@gmail.com",
        cc: null,
        at: "2026-10-13T09:00:00Z",
        body: "<b>hola</b>",
        truncated: true,
      },
      {
        id: "m2",
        from: "bob@x.com",
        to: null,
        cc: null,
        at: "2026-10-13T09:30:00Z",
        body: null,
        truncated: false,
      },
    ],
  };

  test("shows each body as text, never as HTML, and says what is missing", async () => {
    const html = await renderWith(<ThreadView q={read({ data: full })} onClose={() => {}} />);
    expect(html).toContain("Factura");
    expect(html).toContain("&lt;b&gt;hola&lt;/b&gt;");
    expect(html).toContain("Para: me@gmail.com");
    expect(html).toContain("Mensaje cortado");
    expect(html).toContain("Sin texto");
    expect(html).toContain('href="https://mail.example/a1"');
  });

  test("a failed read is an error with Reintentar, never an empty thread", async () => {
    const error = new ApiError(502, "provider_error", "Google 500 on /gmail/thread", "google");
    const html = await renderWith(
      <ThreadView q={read({ isError: true, error })} onClose={() => {}} />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Reintentar");
    expect(html).not.toContain('id="thread-title"');
  });

  test("an expired Google session asks to connect Google", async () => {
    const error = new ApiError(401, "reconnect_required", "expired", "google");
    const html = await renderWith(
      <ThreadView q={read({ isError: true, error })} onClose={() => {}} />,
    );
    expect(html).toContain("Google necesita conectarse");
  });
});

describe("mail profile", () => {
  const profile = {
    trash: [],
    labels: [{ name: "Compras", senders: [{ address: "a@amazon.es", name: "Amazon", count: 4 }] }],
    correspondents: [{ address: "ana@x.com", name: "Ana", count: 2 }],
    senders: [{ address: "n@shop.com", name: "Shop", count: 8, unread: 6, category: "PROMOTIONS" }],
    sampled: { trash: 0, sent: 2, recent: 8, labels: 4 },
  };
  const view = (over: object) => (
    <CleanupView
      q={{ ...read<MailProfile>(over), isFetching: false }}
      onClose={() => {}}
      onReload={() => {}}
    />
  );

  test("shows what the user files, writes to and leaves unread, and says when trash is empty", async () => {
    const html = await renderWith(view({ data: profile }));
    expect(html).toContain("La papelera está vacía");
    expect(html).toContain("Compras");
    expect(html).toContain("Amazon");
    expect(html).toContain("Ana");
    expect(html).toContain("Promociones");
    expect(html).toContain("75 %");
  });

  test("a failed read is an error with Reintentar, never an empty profile", async () => {
    const error = new ApiError(502, "provider_error", "Google 429 on /gmail/message", "google");
    const html = await renderWith(view({ isError: true, error }));
    expect(html).toContain("Reintentar");
    expect(html).not.toContain("papelera está vacía");
  });
});
