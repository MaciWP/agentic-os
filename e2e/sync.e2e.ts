import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { commit, git, throwawayParent } from "./fixture.ts";
import { mainName, noClippedControls, openTree, projectsOf, rowPlus } from "./helpers.ts";

// Writes to git, so only on a throwaway checkout: the profile under test lists a repo with
// id "fixture" whose localPath is AOS_E2E_FIXTURE, under the system temp folder. The suite
// rebuilds it on every run and never clicks "Actualizar repos" for real, since that would
// fast-forward every repo of the profile; its answer is stubbed to check the rendering.
const FIXTURE = process.env.AOS_E2E_FIXTURE;
const EVIDENCE = "data/evidence/w3";

// A bare origin, the checkout the app shows, and a clone that pushes two commits it lacks.
function rebuild(work: string) {
  const root = dirname(work);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, work);
  commit(work, "a.txt");
  git(work, "push", "-q", "-u", "origin", "main");
  const pusher = join(root, "pusher");
  git(root, "clone", "-q", origin, pusher);
  commit(pusher, "b.txt");
  commit(pusher, "c.txt");
  git(pusher, "push", "-q");
  return pusher;
}

test.describe("keeping a checkout up to date", () => {
  test.skip(!FIXTURE, "needs AOS_E2E_FIXTURE and a profile repo with id fixture");
  const work = FIXTURE ?? "";

  test.beforeAll(async ({ request }) => {
    throwawayParent(work);
    // The checkout the server would fast-forward must be this throwaway one, not merely a
    // repo with the same id: a profile pointing "fixture" elsewhere stops the suite here.
    rebuild(work);
    const { repos } = (await (await request.get("/api/projects")).json()) as {
      repos: { id: string; main: { path: string } | null }[];
    };
    const listed = repos.find((r) => r.id === "fixture")?.main?.path;
    expect(listed && realpathSync(listed), "the server's fixture is AOS_E2E_FIXTURE").toBe(
      realpathSync(work),
    );
  });

  test("fetch shows what is new, Avanzar fast-forwards, a changed file stops it", async ({
    page,
  }) => {
    const pusher = rebuild(work);
    const before = git(work, "rev-parse", "HEAD");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/terminales?node=repo:fixture");
    const fixture = (await projectsOf(page)).repos.find((r) => r.id === "fixture");
    if (!fixture) throw new Error("no fixture repo");
    const name = mainName(fixture);
    // Fetch and fast-forward live in the checkout's git tile.
    await (await rowPlus(page, "repo:fixture", name, "Git")).click();
    const pane = page.getByRole("region", { name: `Git de ${name}` });
    const fetch = pane.getByRole("button", { name: "Buscar cambios" });
    const forward = pane.getByRole("button", { name: "Avanzar" });

    // Nothing fetched yet: in step as far as the checkout knows.
    await expect(fetch).toBeVisible();
    await expect(forward).toHaveCount(0);
    await fetch.click();
    await expect(pane.getByRole("status")).toContainText("Remoto consultado");
    await expect(pane.getByText("2 commits por detrás")).toBeAttached();
    expect(git(work, "rev-parse", "HEAD")).toBe(before);

    await forward.click();
    const short = (oid: string) => oid.slice(0, 7);
    const after = git(pusher, "rev-parse", "HEAD");
    await expect(pane.getByRole("status")).toHaveText(
      `main avanzada 2 commits: ${short(before)} → ${short(after)}.`,
    );
    expect(git(work, "rev-parse", "HEAD")).toBe(after);
    await expect(forward).toHaveCount(0);

    // A tracked file changed: refused in the server's words, the branch stays put.
    commit(pusher, "d.txt");
    git(pusher, "push", "-q");
    writeFileSync(join(work, "a.txt"), "edited\n");
    await fetch.click();
    await expect(forward).toBeVisible();
    await forward.click();
    await expect(pane.getByRole("alert")).toHaveText(
      "No avanza: Hay 1 fichero cambiado sin commitear.",
    );
    expect(git(work, "rev-parse", "HEAD")).toBe(after);

    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await noClippedControls(page);
      for (const scheme of ["dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.screenshot({ path: `${EVIDENCE}/pull-${width}-${scheme}.png` });
      }
    }
  });

  test("Actualizar repos lists one line per repo (answer stubbed)", async ({ page }) => {
    let posted = 0;
    await page.route("**/api/git/update-all", (route) => {
      posted++;
      const line = { reason: null, detail: null, commits: 0, submodules: null };
      return route.fulfill({
        json: {
          items: [
            {
              ...line,
              location: "repo:one",
              label: "one",
              result: "updated",
              commits: 3,
              submodules: { moved: ["contract"], kept: [], error: null },
            },
            {
              ...line,
              location: "repo:two",
              label: "two",
              result: "skipped",
              reason: "dirty",
              detail: "Tus cambios sin commitear se pisarían: a.txt.",
            },
          ],
        },
      });
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/terminales");
    const tree = await openTree(page);
    await tree.getByRole("button", { name: "Actualizar repos" }).click();
    const lines = tree.getByRole("list", { name: "Resultado de actualizar repos" });
    await expect(lines.getByRole("listitem")).toHaveText([
      "one avanzado 3 commits · submódulos al día: contract",
      "two sin tocar: Tus cambios sin commitear se pisarían: a.txt.",
    ]);
    expect(posted).toBe(1);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await noClippedControls(page);
      await lines.scrollIntoViewIfNeeded();
      for (const scheme of ["dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.screenshot({ path: `${EVIDENCE}/update-all-${width}-${scheme}.png` });
      }
    }
  });
});
