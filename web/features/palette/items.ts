import type { IconName } from "../../icons.tsx";
import { findNode, type Projects, places } from "../projects/queries.ts";
import { STATE, shortPath } from "../terminals/panel.tsx";
import { kindLabel, type TerminalInfo, terminalLabel } from "../terminals/queries.ts";

// What picking an item does. Tickets and PRs can also go into a Mesa tile (the palette's
// second step); a command acts on the open Mesa; everything else navigates.
export type PaletteAction =
  | { go: "page"; to: Page }
  | { go: "command"; key: string }
  | { go: "terminal"; id: string }
  | { go: "node"; node: string }
  | { go: "ticket"; key: string }
  | { go: "pr"; repo: string; number: number; url: string };

export type PaletteGroup =
  | "Páginas"
  | "Terminales"
  | "Proyectos"
  | "Tickets"
  | "Pull requests"
  | "Mesa abierta";
export const GROUPS: PaletteGroup[] = [
  "Páginas",
  "Terminales",
  "Proyectos",
  "Tickets",
  "Pull requests",
  "Mesa abierta",
];

export type PaletteItem = {
  key: string;
  group: PaletteGroup;
  label: string;
  hint?: string;
  action: PaletteAction;
};

// The main menu's pages, which the palette lists too.
export const PAGES = [
  { to: "/", label: "Inicio", icon: "home" },
  { to: "/terminales", label: "Mesa", icon: "mesa" },
  { to: "/agentes", label: "Agentes", icon: "agents" },
  { to: "/consumo", label: "Consumo", icon: "usage" },
  { to: "/tickets", label: "Tickets", icon: "ticket" },
  { to: "/docs", label: "Notas y memoria", icon: "book" },
] as const satisfies readonly { to: string; label: string; icon: IconName }[];
type Page = (typeof PAGES)[number]["to"];

// Every node of the projects tree, in the tree's order, under the label its rows show.
function nodeLocations(p: Projects): string[] {
  const out: string[] = [];
  for (const e of p.envs.items) out.push(`env:${e.name}`, ...e.checkouts.map((c) => c.location));
  for (const r of p.repos)
    out.push(r.location, ...r.worktrees.flatMap((w) => (w.location ? [w.location] : [])));
  // Once Agentic OS is a repo its node is already listed.
  if (!out.includes(p.app.location)) out.push(p.app.location);
  return out;
}

export function buildItems(data: {
  terminals: TerminalInfo[];
  projects?: Projects;
  tickets?: { key: string; summary: string }[];
  prs?: { repo: string; number: number; title: string; url: string }[];
  // What the open Mesa can do, while the Mesa page is open.
  commands?: { key: string; label: string; hint?: string }[];
}): PaletteItem[] {
  const where = data.projects ? places(data.terminals, data.projects) : new Map();
  return [
    ...PAGES.map(
      (p): PaletteItem => ({
        key: `page:${p.to}`,
        group: "Páginas",
        label: p.label,
        action: { go: "page", to: p.to },
      }),
    ),
    ...data.terminals.map(
      (t): PaletteItem => ({
        key: `t:${t.id}`,
        group: "Terminales",
        label: terminalLabel(t),
        // A named terminal still answers to its harness ("shell" finds a renamed shell).
        hint: [
          t.name && kindLabel(t),
          where.get(t.id)?.label ?? shortPath(t.cwd),
          t.ticket,
          STATE[t.state].label,
        ]
          .filter(Boolean)
          .join(" · "),
        action: { go: "terminal", id: t.id },
      }),
    ),
    ...(data.projects
      ? nodeLocations(data.projects).map(
          (node): PaletteItem => ({
            key: `n:${node}`,
            group: "Proyectos",
            label: (data.projects && findNode(data.projects, node)?.label) ?? node,
            action: { go: "node", node },
          }),
        )
      : []),
    ...(data.tickets ?? []).map(
      (t): PaletteItem => ({
        key: `k:${t.key}`,
        group: "Tickets",
        label: `${t.key} ${t.summary}`,
        action: { go: "ticket", key: t.key },
      }),
    ),
    ...(data.prs ?? []).map(
      (pr): PaletteItem => ({
        key: `pr:${pr.repo}#${pr.number}`,
        group: "Pull requests",
        label: `${pr.repo}#${pr.number} ${pr.title}`,
        action: { go: "pr", repo: pr.repo, number: pr.number, url: pr.url },
      }),
    ),
    ...(data.commands ?? []).map(
      (c): PaletteItem => ({
        key: `c:${c.key}`,
        group: "Mesa abierta",
        label: c.label,
        hint: c.hint,
        action: { go: "command", key: c.key },
      }),
    ),
  ];
}

// Lower case without accents: "categoria" finds "Categoría".
export const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

// The items whose label or hint holds every word typed, in any order, at most `cap` per group,
// in the groups' order.
export function matchItems(items: PaletteItem[], query: string, cap = 8): PaletteItem[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const hits = items.filter((it) => {
    const text = fold(`${it.label} ${it.hint ?? ""}`);
    return words.every((w) => text.includes(w));
  });
  return GROUPS.flatMap((g) => hits.filter((it) => it.group === g).slice(0, cap));
}
