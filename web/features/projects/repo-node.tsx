import { Icon } from "../../icons.tsx";
import { InlineError } from "../../ui.tsx";
import { shortPath } from "../terminals/panel.tsx";
import { RemoveRepo } from "./places.tsx";
import { ProjectIcon } from "./project-tag.tsx";
import { mainLabel } from "./queries.ts";
import { Node, RunningCount, running } from "./tree-node.tsx";
import type { Repo, Tree } from "./tree-types.ts";
import { WorktreeActions } from "./worktree.tsx";

// What a row of a repo is: its main checkout or a worktree. The pill the tree already uses.
const Tag = ({ children }: { children: string }) => (
  <span className="pill h-4 shrink-0 px-1 text-[10px]">{children}</span>
);

// A repo is a heading over its checkouts: the main one and each worktree, siblings with the
// same row, so a terminal says at a glance where it works. A click on the heading marks the
// main checkout and unfolds it; "⋯" holds what acts on the whole repo (a new worktree, off the list).
export function RepoNode({ repo, tree }: { repo: Repo; tree: Tree }) {
  const at = tree.selected.node;
  const branch = repo.main?.branch ?? null;
  const main = (
    <Node
      key={repo.location}
      id={repo.location}
      name={branch ?? "principal"}
      label={mainLabel(repo)}
      title={repo.main?.path}
      canLaunch
      tree={tree}
      // «principal» only tells it apart from its worktrees.
      tag={branch && repo.worktrees.length > 0 && <Tag>principal</Tag>}
    />
  );
  const worktrees = repo.worktrees.map((w) => {
    const name = w.branch ?? shortPath(w.path);
    return (
      <Node
        key={w.path}
        id={w.location ?? w.path}
        name={name}
        label={`${repo.id}/${name}`}
        title={w.path}
        canLaunch={w.location !== null}
        canOpen={w.location !== null}
        tree={tree}
        more={
          w.location !== null &&
          w.removable && (
            <WorktreeActions
              kind="worktree"
              repo={repo.id}
              node={w.location}
              removable
              setup={tree.worktrees}
              pushRight={false}
            />
          )
        }
        tag={<Tag>worktree</Tag>}
        // A detached worktree has no branch to name it by, so it takes no launch.
        detail={!w.location && <span className="text-[11px] text-ink-2">sin rama</span>}
      />
    );
  });
  return (
    <Node
      id={`repo-group:${repo.id}`}
      name={repo.id}
      icon={
        <ProjectIcon name={repo.group ?? repo.id}>
          <Icon name="git" size={12} />
        </ProjectIcon>
      }
      title={[repo.github, repo.main?.path].filter(Boolean).join("\n") || undefined}
      canLaunch={false}
      picks={{ id: repo.location, label: mainLabel(repo) }}
      canOpen={false}
      defaultOpen={false}
      holds={at === repo.location || repo.worktrees.some((w) => (w.location ?? w.path) === at)}
      tree={tree}
      more={
        <>
          <WorktreeActions
            kind="repo"
            repo={repo.id}
            node={repo.location}
            removable={false}
            setup={tree.worktrees}
            pushRight={false}
          />
          {repo.removable && <RemoveRepo id={repo.id} />}
        </>
      }
      folded={
        <RunningCount
          n={running(
            [repo.location, ...repo.worktrees.map((w) => w.location ?? w.path)].flatMap(
              (n) => tree.byNode.get(n) ?? [],
            ),
          )}
        />
      }
      info={
        repo.error && (
          <InlineError className="break-words px-2 pb-1 pl-6 font-mono text-[11px]">
            {repo.error}
          </InlineError>
        )
      }
      nested={[main, ...worktrees]}
    />
  );
}
