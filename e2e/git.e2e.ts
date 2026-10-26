import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import {
  appNode,
  currentMesa,
  mainName,
  noClippedControls,
  openTree,
  projectsOf,
  resetWorkspace,
  rowPlus,
  unfoldRepo,
} from "./helpers.ts";

// Read only: the git tiles in the Mesa on the app's own checkout, checked against git
// itself, and the tree's counts against the summary. Evidence holds company data.
const EVIDENCE = "data/evidence/w2";

// The tiles' layout is the test's: it starts from one empty Mesa, whatever an earlier file left.
test.beforeEach(async ({ request }) => resetWorkspace(request));

type Status = {
  repo: boolean;
  branch: string | null;
  upstream: string | null;
  files: { path: string; x: string; y: string; kind: string }[];
};

// The same listing the server reads, from the CLI, without taking the index lock.
function gitPaths(): string[] {
  const out = execFileSync("git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).toString();
  const records = out.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i] ?? "";
    if (r.startsWith("1 ")) paths.push(r.split(" ").slice(8).join(" "));
    else if (r.startsWith("2 ")) {
      paths.push(r.split(" ").slice(9).join(" "));
      i++;
    } else if (r.startsWith("u ")) paths.push(r.split(" ").slice(10).join(" "));
    else if (r.startsWith("? ")) paths.push(r.slice(2));
  }
  return paths.sort();
}

test("git opens as a Mesa tile that lists what git lists and shows a file's diff", async ({
  page,
}) => {
  const s = (await (await page.request.get("/api/git/status?location=app")).json()) as Status;
  expect(s.repo).toBe(true);
  expect(s.files.map((f) => f.path).sort()).toEqual(gitPaths());
  const untracked = s.files.filter((f) => f.kind === "untracked");
  const staged = s.files.filter((f) => f.kind !== "conflict" && f.x !== "." && f.x !== "?");
  const rest = s.files.filter((f) => f.kind === "conflict" || f.y !== ".");

  await page.setViewportSize({ width: 1280, height: 800 });
  // An old projects link lands in the Mesa with the node marked in the tree, no drawer.
  await page.goto("/proyectos?node=app&tab=git");
  await expect.poll(async () => (await currentMesa(page))?.node).toBe("app");
  await expect(page.getByRole("complementary", { name: /^Proyecto / })).toHaveCount(0);
  const p = await projectsOf(page);
  const { name: appName, row: app, location } = await appNode(page);
  await expect(app).toHaveAttribute("aria-current", "true");
  // With Git picked above the tree, the row's «+» opens its git as a tile.
  const launch = await rowPlus(page, location, appName, "Git");
  await expect(launch).toBeVisible();
  await noClippedControls(page);
  await launch.click();
  await expect
    .poll(async () => (await currentMesa(page))?.ids)
    .toContain(`git:${encodeURIComponent(p.app.location)}`);

  const tile = page.getByRole("region", { name: `Git de ${appName}` });
  await expect(tile).toBeVisible();
  const rows = tile.locator("[data-pick]");
  await expect(rows).toHaveCount(staged.length + rest.length);
  if (untracked.length > 0)
    await expect(tile.getByRole("region", { name: "Sin seguimiento" })).toContainText(
      String(untracked.length),
    );

  // Alone beside the rail the tile is wide: the list and the diff side by side; the keys move
  // only inside it.
  const row = rows.first();
  const name = (await row.getAttribute("aria-label")) ?? "";
  const path = name.slice(0, name.lastIndexOf(", "));
  await row.click();
  await expect(tile.getByRole("region", { name: `Diff de ${path}` })).toBeVisible();
  await expect(rows.first()).toBeVisible();
  await expect(tile.getByRole("button", { name: "Ficheros" })).toBeHidden();
  if (staged.length + rest.length > 1) {
    await rows.first().focus();
    await page.keyboard.press("j");
    await expect(tile.locator('[data-pick][aria-pressed="true"]')).not.toHaveAttribute(
      "aria-label",
      name,
    );
  }
  await noClippedControls(page);
  await page.screenshot({ path: `${EVIDENCE}/git-tile-wide-1280-dark.png` });

  // A second checkout's git joins as another tile, from its own row; side by side each is
  // narrow: a file opens its diff in place, and back.
  const other = p.repos.find((r) => r.main && r.location !== p.app.location);
  if (other) {
    await unfoldRepo(page, other.id);
    await (await rowPlus(page, other.location, mainName(other), "Git")).click();
    await expect(page.locator("[data-git-tile]")).toHaveCount(2);
    await expect(tile).toBeVisible();
    // The file picked while wide keeps its diff, now in place of the list.
    await expect(tile.getByRole("region", { name: /^Diff de / })).toBeVisible();
    await expect(rows.first()).toBeHidden();
    await tile.getByRole("button", { name: "Ficheros" }).click();
    await expect(rows.first()).toBeVisible();
    await rows.first().click();
    await expect(tile.getByRole("region", { name: /^Diff de / })).toBeVisible();
    await expect(rows.first()).toBeHidden();
    await tile.getByRole("button", { name: "Ficheros" }).click();
    await expect(rows.first()).toBeVisible();
    await noClippedControls(page);
    await page.screenshot({ path: `${EVIDENCE}/git-tiles-two-1280-dark.png` });
  }
});

test("each checkout in the tree shows the summary's counts", async ({ page }) => {
  // The summary the page itself read: other sessions keep changing this checkout, so one read
  // apart can count a file more or less than the tree shows.
  const summary = page.waitForResponse((r) => r.url().endsWith("/api/git/summary") && r.ok());
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/terminales?node=app");
  const { items } = (await (await summary).json()) as {
    items: Record<string, { ahead: number | null; behind: number | null; changed: number }>;
  };
  const tree = await openTree(page);
  // An env's checkouts sit under it, and a repo's under its heading, folded until opened.
  const folded = tree.getByRole("button", { name: /^Desplegar / });
  // Each click renames its button to "Plegar …", so the first folded one is always the next;
  // an unfolded heading can show more folded rows.
  for (let n = 0; n < 50 && (await folded.count()) > 0; n++) await folded.first().click();
  const shown = Object.values(items).filter((g) => g.ahead || g.behind || g.changed);
  expect(shown.length).toBeGreaterThan(0);
  for (const g of shown) {
    const parts = [g.ahead ? `↑${g.ahead}` : "", g.behind ? `↓${g.behind}` : ""].filter(Boolean);
    const text = [parts.join(" "), g.changed ? `${g.changed} cambio` : ""]
      .filter(Boolean)
      .join(" · ");
    await expect(tree.getByText(new RegExp(`^${text}s?$`)).first()).toBeAttached();
  }
  for (const scheme of ["dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await tree.screenshot({ path: `${EVIDENCE}/tree-counts-1280-${scheme}.png` });
  }
});
