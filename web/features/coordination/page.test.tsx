import { expect, test } from "bun:test";
import { failQuery, renderWith } from "../../test-render.tsx";
import { AgentsPage } from "../monitor/page.tsx";
import { CoordinationPage } from "./page.tsx";

const empty = {
  revision: 0,
  agents: [],
  messages: [],
  consultations: [],
  reservations: [],
  audit: [],
};
test("coordination stays inside Agents and keeps the activity view reachable", async () => {
  const html = await renderWith(<AgentsPage search={{ s: "mensajes" }} />, [
    [["coordination"], empty],
  ]);
  for (const name of [
    "Actividad",
    "Consultas",
    "Mensajes",
    "Reservas",
    "Todavía no hay mensajes",
    "Enviar mensaje",
  ])
    expect(html).toContain(name);
  expect(html).toContain("Entregado significa escrito en la terminal");
});
test("reservations explain the cooperative limit and preserve orphaned owners", async () => {
  const html = await renderWith(<CoordinationPage section="reservas" />, [
    [
      ["coordination"],
      {
        ...empty,
        reservations: [
          {
            id: "r",
            owner: "lost-agent",
            path: "/repo/code.ts",
            reason: "API",
            status: "orphaned",
          },
        ],
      },
    ],
  ]);
  expect(html).toContain("Huérfana");
  expect(html).toContain("No impiden que un editor lo modifique");
  expect(html).toContain("Liberar");
});
test("coordination fetch failure is never rendered as an empty list", async () => {
  const html = await renderWith(
    <CoordinationPage section="consultas" />,
    [],
    failQuery(["coordination"]),
  );
  expect(html).toContain('role="alert"');
  expect(html).not.toContain("Todavía no hay consultas");
});
