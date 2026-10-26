import { describe, expect, test } from "bun:test";
import type { AgendaEvent } from "../../../server/features/google/client.ts";
import type { MailThread } from "../../../shared/mail-inbox.ts";
import { renderWith } from "../../test-render.tsx";
import { nextMeeting, type SummaryInput, SummaryView } from "./summary.tsx";

const now = Date.parse("2026-10-14T10:00:00Z");
const event = (id: string, start: string, end: string, over: Partial<AgendaEvent> = {}) =>
  ({
    id,
    title: id,
    start,
    end,
    allDay: false,
    location: null,
    meet: null,
    link: `l/${id}`,
    ...over,
  }) as AgendaEvent;
const mailThread = (unread: boolean, starred: boolean) => ({ unread, starred }) as MailThread;
const ok = <T,>(data: T) => ({ isPending: false, isError: false, data });
const none = { failed: 0, asks: 0, review: 0 };

const render = (over: Partial<SummaryInput>) =>
  renderWith(
    <SummaryView
      agenda={ok({ events: [] })}
      mail={ok({ threads: [] })}
      needs={{ complete: true, byUrgency: none }}
      now={now}
      {...over}
    />,
  );

describe("day summary", () => {
  test("the meeting going on wins; an all-day or ended event never counts", () => {
    const events = [
      event("allday", "2026-10-14", "2026-10-15", { allDay: true }),
      event("ended", "2026-10-14T08:00:00Z", "2026-10-14T09:00:00Z"),
      event("live", "2026-10-14T09:30:00Z", "2026-10-14T10:30:00Z"),
      event("later", "2026-10-14T12:00:00Z", "2026-10-14T13:00:00Z"),
    ];
    expect(nextMeeting(events, now)).toMatchObject({ e: { id: "live" }, live: true });
    expect(nextMeeting(events.slice(3), now)).toMatchObject({ e: { id: "later" }, live: false });
    expect(nextMeeting(events.slice(0, 2), now)).toBeNull();
  });

  test("says what waits by kind and the mail counts", async () => {
    const html = await render({
      needs: { complete: true, byUrgency: { failed: 1, asks: 2, review: 0 } },
      mail: ok({ threads: [mailThread(true, true), mailThread(true, false)] }),
    });
    expect(html).toContain("2 agentes te preguntan · 1 terminal falló");
    expect(html).not.toContain("PR");
    expect(html).toContain("1 destacado · 2 sin leer");
    expect(html).toContain("Sin más reuniones hoy");
  });

  test("a source not read is said, never a zero", async () => {
    const html = await render({
      agenda: { isPending: false, isError: true },
      mail: ok({ disabled: true as const }),
      needs: { complete: false, byUrgency: { failed: 0, asks: 1, review: 0 } },
    });
    expect(html).toContain("Agenda: no se pudo leer");
    expect(html).toContain("Correo: sin conectar");
    expect(html).toContain("al menos 1 agente te pregunta");
    expect(html).not.toContain("Sin más reuniones");
    const quiet = await render({ needs: { complete: false, byUrgency: none } });
    expect(quiet).toContain("Faltan datos para saber qué te espera");
  });
});
