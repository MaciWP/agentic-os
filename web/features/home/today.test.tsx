import { describe, expect, test } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";
import type { AgendaEvent } from "../../../server/features/google/client.ts";
import type { Meeting } from "../../../shared/meetings.ts";
import type { Task } from "../../../shared/objectives.ts";
import { ApiError } from "../../api.ts";
import { failQuery, renderWith } from "../../test-render.tsx";
import { MailColumn, macTitle } from "./mail-column.tsx";
import { MeetingNoteView } from "./meeting-note.tsx";
import { TodayList } from "./today-list.tsx";
import { localDay, type MailItem } from "./today-model.ts";

const mail: MailItem = {
  account: "outlook",
  id: "42",
  key: "abc@example.test",
  from: "Ana Pérez",
  subject: null,
  at: "2026-10-16T08:00:00Z",
  unread: true,
  flagged: true,
  snippet: null,
};

const read = (over: object) => ({
  isPending: false,
  isError: false,
  error: null,
  data: undefined,
  refetch: () => {},
  ...over,
});

const column = (q: object, linked: string[] = []) =>
  renderWith(
    <MailColumn
      label="Trabajo"
      provider="Outlook"
      q={read(q)}
      read={(d: { items: MailItem[]; total: number }) => d}
      open="42"
      linked={new Set(linked)}
      onOpen={() => {}}
      onTask={() => {}}
      errorTitle={macTitle}
    />,
  );

describe("a mail column", () => {
  test("a row opens in place, can be dragged, and says unread, flagged and no subject", async () => {
    const html = await column({ data: { items: [mail], total: 300 } });
    expect(html).toContain('draggable="true"');
    expect(html).toContain('data-thread="42"');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("(sin asunto)");
    expect(html).toContain("Marcado");
    expect(html).toContain("1 de 300");
    expect(html).toContain("Crear tarea: (sin asunto)");
  });

  test("a mail already behind a task says so instead of offering another", async () => {
    const html = await column({ data: { items: [mail], total: 1 } }, ["abc@example.test"]);
    expect(html).toContain("En Hoy");
    expect(html).not.toContain("Crear tarea");
  });

  test("a closed Mail is named, never an empty inbox", async () => {
    const error = new ApiError(503, "mail_closed", "");
    const html = await column({ isError: true, error });
    expect(html).toContain("Abre Mail para leer Outlook");
    expect(html).toContain("Reintentar");
    expect(html).not.toContain("vacía");
    expect(await column({ data: { disabled: true } })).toContain("Outlook está desactivado");
  });
});

describe("«Hoy»", () => {
  const day = localDay(0);
  const at = (h: number) => new Date(Date.parse(day.from) + h * 3600_000).toISOString();
  const event: AgendaEvent = {
    source: "google",
    id: "g1",
    occurrence: null,
    title: "Revisión de sprint",
    start: at(10),
    end: at(11),
    allDay: false,
    location: null,
    meet: "https://meet.example/x",
    link: "https://calendar.example/g1",
    attendees: [],
  };
  const task = (id: number, over: Partial<Task>): Task => ({
    id,
    title: `t${id}`,
    createdAt: day.from,
    closedAt: null,
    dueOn: null,
    dueHm: null,
    priority: 0,
    position: id,
    about: null,
    source: null,
    sourceKey: null,
    ...over,
  });
  const yesterday: Meeting = {
    id: 9,
    source: "outlook",
    eventKey: "o1",
    occurrence: null,
    title: "Comité de ayer",
    start: at(-14),
    end: at(-13),
    allDay: false,
    noteId: null,
    closedAt: null,
  };
  const render = (extra: [unknown[], unknown][] = [], setup?: Parameters<typeof renderWith>[2]) =>
    renderWith(
      <TodayList
        day={day}
        mailOf={(t) => (t.source === "mail:outlook" ? "moved" : null)}
        onLanes={() => {}}
        onNote={() => {}}
      />,
      [
        [["mac", "outlook", "agenda"], { disabled: true }],
        [["meetings", "open", day.from], { meetings: [yesterday] }],
        [
          ["objectives", "tasks", day.from],
          {
            tasks: [
              task(1, { title: "Llamar a Luis", dueOn: day.day, dueHm: "12:30" }),
              task(2, { title: "Enviar oferta", dueOn: "2020-01-01", priority: 1 }),
              task(3, { title: "Contestar a Ana", source: "mail:outlook", sourceKey: "x@y" }),
            ],
          },
        ],
        ...extra,
      ],
      setup,
    );

  test("meetings and timed tasks by the clock, the rest by priority, and what earlier days left", async () => {
    const html = await render([[["google", "agenda"], { events: [event] }]]);
    expect(html.indexOf("Revisión de sprint")).toBeLessThan(html.indexOf("Llamar a Luis"));
    expect(html).toContain('href="https://meet.example/x"');
    expect(html.indexOf("Enviar oferta")).toBeLessThan(html.indexOf("Contestar a Ana"));
    expect(html).toContain("vencida");
    expect(html).toContain("Correo movido");
    expect(html).toContain("Comité de ayer");
    expect(html).toContain("Cerrar las de días anteriores");
  });

  test("a calendar that failed says so with its retry; one that is off says nothing", async () => {
    const html = await render([], failQuery(["google", "agenda"], undefined, "boom"));
    expect(html).toContain("Google: boom");
    expect(html).toContain("Reintentar");
    expect(html).not.toContain("Outlook:");
  });

  test("Outlook without the Calendars grant offers «Dar permiso»; Google never does", async () => {
    const missing = (key: unknown[], code: string) => (client: QueryClient) =>
      client
        .getQueryCache()
        .build(client, { queryKey: key })
        .setState({ status: "error", error: new ApiError(503, code, ""), fetchStatus: "idle" });
    const html = await render([], missing(["mac", "outlook", "agenda"], "not_granted"));
    expect(html).toContain("Outlook: AgenticMac necesita permiso");
    expect(html).toContain("Dar permiso");
    const google = await render([], missing(["google", "agenda"], "not_granted"));
    expect(google).not.toContain("Dar permiso");
    const closed = await render([], missing(["mac", "outlook", "agenda"], "timeout"));
    expect(closed).not.toContain("Dar permiso");
  });

  test("a calendar never connected says so, not its error code", async () => {
    const html = await render([], (client) =>
      client
        .getQueryCache()
        .build(client, { queryKey: ["google", "agenda"] })
        .setState({
          status: "error",
          error: new ApiError(401, "reconnect_required", "not connected", "google"),
          fetchStatus: "idle",
        }),
    );
    expect(html).toContain("Google: sin conectar");
    expect(html).not.toContain("reconnect_required");
  });
});

describe("a meeting's note", () => {
  const meeting: Meeting = {
    id: 4,
    source: "outlook",
    eventKey: "o4",
    occurrence: null,
    title: "Comité",
    start: "2026-10-16T09:00:00.000Z",
    end: "2026-10-16T10:00:00.000Z",
    allDay: false,
    noteId: "notes:Reunion 2026-10-16 abcd1234.md",
    closedAt: null,
  };
  const doc = (body: string) => ({
    doc: {
      id: meeting.noteId,
      source: "notes",
      rel: "Reunion 2026-10-16 abcd1234.md",
      title: "Reunión · Comité",
      description: null,
      mtime: 1,
      writable: true,
      body,
    },
  });
  const view = (body: string, made: { sourceKey: string }[]) =>
    renderWith(
      <MeetingNoteView meeting={meeting} noteId={meeting.noteId as string} onBack={() => {}} />,
      [
        [["memory", "doc", meeting.noteId], doc(body)],
        [["objectives", "tasks", "source", "meeting:4"], { tasks: made }],
      ],
    );

  test("counts the open lines not passed yet and edits the saved note", async () => {
    const html = await view("## Tareas\n- [ ] Enviar acta\n- [ ] Llamar a Ana\n- [x] Hecho\n", [
      { sourceKey: "llamar a ana" },
    ]);
    expect(html).toContain("Pasar 1 a tareas");
    expect(html).toContain("Cerrar reunión");
    expect(html).toContain("Enviar acta");
    expect(html).toContain('aria-label="Contenido"');
  });

  test("nothing left to pass says so", async () => {
    const html = await view("- [ ] Llamar a Ana\n", [{ sourceKey: "llamar a ana" }]);
    expect(html).toContain("Nada por pasar a tareas");
  });
});
