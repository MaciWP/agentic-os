import { existsSync, mkdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { commit, git, throwawayParent } from "./fixture.ts";
import {
  noClippedControls,
  origin,
  removeTerminals,
  rowMore,
  rowPlus,
  treeRow,
} from "./helpers.ts";

// Adds and removes worktrees, so only on a throwaway checkout: the profile under test lists
// a repo with id "wt" whose localPath is AOS_E2E_WT_FIXTURE, under the system temp folder,
// and its worktrees.root is the folder "trees" next to it. The suite rebuilds both per run.
const FIXTURE = process.env.AOS_E2E_WT_FIXTURE;
const EVIDENCE = "data/evidence/w4";

// A bare origin with main, and the checkout the app shows, which ignores .env.
function rebuild(work: string) {
  const root = dirname(work);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "trees"), { recursive: true });
  const bare = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  git(root, "clone", "-q", bare, work);
  commit(work, ".gitignore", ".env\n");
  commit(work, "a.txt");
  git(work, "push", "-q", "-u", "origin", "main");
  // A clone of an empty origin has no origin/HEAD; the app never sets it by itself.
  git(work, "remote", "set-head", "origin", "main");
}

async function shoot(page: Page, name: string) {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await noClippedControls(page);
    for (const scheme of ["dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: `${EVIDENCE}/${name}-${width}-${scheme}.png` });
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
}

test.describe("native worktrees", () => {
  test.skip(!FIXTURE, "needs AOS_E2E_WT_FIXTURE and a profile repo with id wt");
  const work = FIXTURE ?? "";

  test.beforeAll(async ({ request }) => {
    throwawayParent(work);
    rebuild(work);
    // The checkout the server would add worktrees to must be this throwaway one, and its
    // root must be usable: a profile pointing "wt" elsewhere stops the suite here.
    const p = (await (await request.get("/api/projects")).json()) as {
      repos: { id: string; main: { path: string } | null }[];
      worktrees: { error: string | null };
    };
    const listed = p.repos.find((r) => r.id === "wt")?.main?.path;
    expect(listed && realpathSync(listed), "the server's wt is AOS_E2E_WT_FIXTURE").toBe(
      realpathSync(work),
    );
    expect(p.worktrees.error).toBeNull();
  });

  test("create a branch's worktree, work in it, and remove it only when it is safe", async ({
    page,
  }) => {
    const api = (path: string, method = "POST") =>
      page.request.fetch(path, { method, headers: { origin, "content-type": "application/json" } });
    const trees = realpathSync(join(dirname(work), "trees"));
    const path = join(trees, "wt", "feat-e2e");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/terminales?node=repo:wt");

    // "Nuevo worktree" waits behind the repo row's "⋯".
    const repo = await rowMore(page, "repo:wt", "wt");
    await repo.getByRole("button", { name: "Nuevo worktree" }).click();
    const form = repo.getByRole("form", { name: "Nuevo worktree de wt" });
    await expect(form.getByRole("combobox", { name: "Base" })).toHaveValue(
      "refs/remotes/origin/main",
    );
    await form.getByRole("combobox", { name: "Rama" }).fill("feat/e2e");
    await shoot(page, "new");
    await form.getByRole("button", { name: "Crear worktree" }).click();

    // The app marks the new node in the tree; git has the worktree where the profile says, on
    // a new branch with no upstream.
    const node = "wt:wt:feat/e2e";
    await expect(treeRow(page, node)).toHaveAttribute("aria-current", "true");
    const pane = await rowMore(page, node, "wt/feat/e2e");
    await expect(pane.getByRole("button", { name: "Quitar worktree" })).toBeVisible();
    expect(git(work, "worktree", "list", "--porcelain")).toContain(`worktree ${path}\n`);
    expect(git(path, "branch", "--show-current")).toBe("feat/e2e");
    expect(() => git(work, "config", "--get", "branch.feat/e2e.remote")).toThrow();

    // A shell inside: the folder cannot go while it runs.
    await (await rowPlus(page, node, "wt/feat/e2e", "Shell")).click();
    await expect(treeRow(page, node).getByTitle("1 en marcha dentro")).toBeVisible();
    const { terminals } = (await (await api("/api/terminals", "GET")).json()) as {
      terminals: { id: string; location: string }[];
    };
    const shell = terminals.find((t) => t.location === "wt:wt:feat/e2e");
    expect(shell).toBeDefined();
    const id = shell?.id ?? "";
    try {
      // The launch closed "⋯"; open it again for the remove.
      const strip = await rowMore(page, node, "wt/feat/e2e");
      await strip.getByRole("button", { name: "Quitar worktree" }).click();
      const remove = strip.getByRole("button", { name: "Quitar", exact: true });
      await remove.click();
      await expect(strip.getByRole("alert")).toHaveText(
        "No se ha quitado: Hay una terminal en marcha en este checkout; páralas antes de tocarlo.",
      );
      await api(`/api/terminals/${id}/stop`);
      await expect
        .poll(async () => {
          const r = (await (await api("/api/terminals", "GET")).json()) as {
            terminals: { id: string; state: string }[];
          };
          return r.terminals.find((t) => t.id === id)?.state;
        })
        .not.toBe("running");

      // An untracked file: git refuses, in its own words, and the file stays.
      writeFileSync(join(path, "notes.txt"), "mine\n");
      await remove.click();
      await expect(strip.getByRole("alert")).toContainText("contains modified or untracked files");
      expect(existsSync(join(path, "notes.txt"))).toBe(true);

      // Only an ignored file: git would delete it silently, so the app asks first.
      unlinkSync(join(path, "notes.txt"));
      writeFileSync(join(path, ".env"), "SECRET=1\n");
      await remove.click();
      await expect(strip.getByRole("alert")).toHaveText(
        "No se ha quitado: Tiene ficheros ignorados que se borrarían con él: .env.",
      );
      await shoot(page, "remove-ignored");
      await strip.getByRole("button", { name: "Quitar igualmente" }).click();

      // Back on the repo, marked; the folder is gone and the branch stays.
      await expect(treeRow(page, "repo:wt")).toHaveAttribute("aria-current", "true");
      await expect(treeRow(page, node)).toHaveCount(0);
      expect(existsSync(path)).toBe(false);
      expect(git(work, "worktree", "list", "--porcelain")).not.toContain(path);
      expect(git(work, "branch", "--list", "feat/e2e")).toContain("feat/e2e");
    } finally {
      await removeTerminals(page.request, [id]);
    }
  });
});
