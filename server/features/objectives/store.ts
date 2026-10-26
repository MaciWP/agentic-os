import type { Database } from "bun:sqlite";
import type {
  GoalPatch,
  NewGoal,
  Objective,
  ObjectiveChoice,
  Task,
} from "../../../shared/objectives.ts";
import { Listeners } from "../../listeners.ts";
import type { TerminalInfo, Terminals } from "../terminals/contract.ts";
import { decorated } from "../terminals/decorated.ts";

export class ObjectiveError extends Error {
  readonly status: 404 | 409;
  constructor(
    readonly code: "not_found" | "closed",
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.status = code === "not_found" ? 404 : 409;
  }
}

type Row = {
  id: number;
  kind: "ticket" | "goal";
  ticket: string | null;
  title: string | null;
  closed_at: string | null;
};

const objectiveOf = (r: Row): Objective =>
  r.kind === "ticket"
    ? { kind: "ticket", id: r.id, ticket: r.ticket ?? "" }
    : { kind: "goal", id: r.id, title: r.title ?? "", closedAt: r.closed_at };

type TaskRow = {
  id: number;
  title: string;
  created_at: string;
  closed_at: string | null;
  due_on: string | null;
  due_hm: string | null;
  priority: 0 | 1;
  position: number | null;
  about: string | null;
  source: string | null;
  source_key: string | null;
};
const TASK_COLUMNS =
  "id, title, created_at, closed_at, due_on, due_hm, priority, position, about, source, source_key";
const taskOf = (r: TaskRow): Task => ({
  id: r.id,
  title: r.title,
  createdAt: r.created_at,
  closedAt: r.closed_at,
  dueOn: r.due_on,
  dueHm: r.due_hm,
  priority: r.priority,
  position: r.position,
  about: r.about,
  source: r.source,
  sourceKey: r.source_key,
});

export const goalOf = (t: Task): Objective => ({
  kind: "goal",
  id: t.id,
  title: t.title,
  closedAt: t.closedAt,
});

// The task fields a patch may set, by their column. A fixed list: no key reaches SQL as text.
const PATCH_COLUMNS = {
  title: "title",
  position: "position",
  dueOn: "due_on",
  dueHm: "due_hm",
  priority: "priority",
  about: "about",
} as const;

const now = () => new Date().toISOString();

// What a terminal works on, and the objective each agent session ran under (ADR 0013: the
// server owns these tables). A terminal with no choice works on the ticket it was launched with.
export class ObjectiveStore {
  private readonly listeners = new Listeners();

  constructor(private readonly db: Database) {}

  subscribe(listener: () => void): () => void {
    return this.listeners.add(listener);
  }

  // Open goals first, newest first; then the tickets linked so far.
  list(): Objective[] {
    return this.db
      .query<Row, []>(
        `SELECT id, kind, ticket, title, closed_at FROM objectives
         WHERE closed_at IS NULL ORDER BY kind = 'ticket', id DESC`,
      )
      .all()
      .map(objectiveOf);
  }

  createGoal(title: string): Objective {
    return goalOf(this.addTask({ title }));
  }

  // A task at the end of the list. One whose source already made a task returns that task.
  addTask(goal: NewGoal): Task {
    const task = this.insertTask(goal);
    this.listeners.notify();
    return task;
  }

  // A meeting note's checklist: every line once, however often it is sent.
  addTasks(goals: NewGoal[]): Task[] {
    const tasks = this.db.transaction(() => goals.map((g) => this.insertTask(g)))();
    this.listeners.notify();
    return tasks;
  }

  // Edits a task. Clearing its day clears its time too.
  patchTask(id: number, patch: GoalPatch): Task {
    const keys = Object.keys(patch) as (keyof GoalPatch)[];
    const sets = keys.map((k) => `${PATCH_COLUMNS[k]} = ?`).join(", ");
    const values = keys.map((k) => patch[k] ?? null);
    const row = this.db
      .query<TaskRow, (string | number | null)[]>(
        `UPDATE objectives SET ${sets} WHERE id = ? AND kind = 'goal' RETURNING ${TASK_COLUMNS}`,
      )
      .get(...values, id);
    if (!row) throw new ObjectiveError("not_found", `no task ${id}`);
    if (row.due_hm && !row.due_on) {
      this.db.run("UPDATE objectives SET due_hm = NULL WHERE id = ?", [id]);
      row.due_hm = null;
    }
    this.listeners.notify();
    return taskOf(row);
  }

  private insertTask(g: NewGoal): Task {
    const row = this.db
      .query<TaskRow, (string | number | null)[]>(
        `INSERT INTO objectives
           (kind, title, created_at, due_on, due_hm, priority, about, source, source_key, position)
         VALUES ('goal', ?, ?, ?, ?, ?, ?, ?, ?,
           (SELECT coalesce(max(position), 0) + 1 FROM objectives WHERE kind = 'goal'))
         ON CONFLICT (source, source_key) DO NOTHING
         RETURNING ${TASK_COLUMNS}`,
      )
      .get(
        g.title,
        now(),
        g.dueOn ?? null,
        g.dueHm ?? null,
        g.priority ?? 0,
        g.about ?? null,
        g.source ?? null,
        g.sourceKey ?? null,
      );
    if (row) return taskOf(row);
    const made = this.db
      .query<TaskRow, [string, string]>(
        `SELECT ${TASK_COLUMNS} FROM objectives WHERE source = ? AND source_key = ?`,
      )
      .get(g.source ?? "", g.sourceKey ?? "");
    return taskOf(made as TaskRow);
  }

  // The goals alive during a day: created before it ends and not closed before it starts. One
  // closed within the day is done on that day; one still open is carried to the next. An open
  // one due on a later day waits for it. `day` is the local date of [from, to).
  tasks(from: string, to: string, day: string): Task[] {
    return this.db
      .query<TaskRow, [string, string, string]>(
        `SELECT ${TASK_COLUMNS} FROM objectives
         WHERE kind = 'goal' AND created_at < ? AND (closed_at IS NULL OR closed_at >= ?)
           AND (closed_at IS NOT NULL OR due_on IS NULL OR due_on <= ?)
         ORDER BY closed_at IS NOT NULL, position, id`,
      )
      .all(to, from, day)
      .map(taskOf);
  }

  // Every task one origin made, open or not, whatever its day: what a meeting note already
  // turned into tasks.
  bySource(source: string): Task[] {
    return this.db
      .query<TaskRow, [string]>(
        `SELECT ${TASK_COLUMNS} FROM objectives WHERE kind = 'goal' AND source = ? ORDER BY id`,
      )
      .all(source)
      .map(taskOf);
  }

  reopen(id: number): Objective {
    const row = this.db
      .query<Row, [number]>(
        `UPDATE objectives SET closed_at = NULL WHERE id = ?
         RETURNING id, kind, ticket, title, closed_at`,
      )
      .get(id);
    if (!row) throw new ObjectiveError("not_found", `no objective ${id}`);
    this.listeners.notify();
    return objectiveOf(row);
  }

  close(id: number): Objective {
    const row = this.db
      .query<Row, [string, number]>(
        `UPDATE objectives SET closed_at = coalesce(closed_at, ?) WHERE id = ?
         RETURNING id, kind, ticket, title, closed_at`,
      )
      .get(now(), id);
    if (!row) throw new ObjectiveError("not_found", `no objective ${id}`);
    this.listeners.notify();
    return objectiveOf(row);
  }

  // The terminal's objective: its choice, else its launch ticket (a ticket not yet linked has
  // no id). null: none chosen, or launched without a ticket.
  of(t: Pick<TerminalInfo, "id" | "ticket">): Objective | null {
    const chosen = this.db
      .query<{ objective_id: number | null }, [string]>(
        "SELECT objective_id FROM terminal_objectives WHERE terminal_id = ?",
      )
      .get(t.id);
    if (chosen) return chosen.objective_id === null ? null : this.byId(chosen.objective_id);
    if (!t.ticket) return null;
    const row = this.ticketRow(t.ticket);
    return row ? objectiveOf(row) : { kind: "ticket", id: null, ticket: t.ticket };
  }

  // The terminal as every reader sees it: `ticket` is the effective one, so the Mesa names,
  // the phone list, Inicio and the workboard context follow the user's choice.
  decorate(t: TerminalInfo): TerminalInfo {
    const objective = this.of(t);
    return { ...t, ticket: objective?.kind === "ticket" ? objective.ticket : null, objective };
  }

  // Sets a terminal's objective. The session it runs now moves with it; earlier ones keep theirs.
  choose(t: Pick<TerminalInfo, "id" | "ticket" | "harness" | "agent">, choice: ObjectiveChoice) {
    this.db.transaction(() => {
      if ("launch" in choice) {
        this.db.run("DELETE FROM terminal_objectives WHERE terminal_id = ?", [t.id]);
      } else {
        const id =
          "none" in choice
            ? null
            : "ticket" in choice
              ? this.linkTicket(choice.ticket)
              : this.openGoal(choice.objective);
        this.db.run(
          `INSERT INTO terminal_objectives (terminal_id, objective_id) VALUES (?, ?)
           ON CONFLICT (terminal_id) DO UPDATE SET objective_id = excluded.objective_id`,
          [t.id, id],
        );
      }
      const session = t.agent?.sessionId;
      if (session) {
        this.db.run("DELETE FROM session_objectives WHERE harness = ? AND session_id = ?", [
          t.harness,
          session,
        ]);
        this.freeze(t, session);
      }
    })();
    this.listeners.notify();
  }

  // Files a new agent session under the terminal's objective; a session already filed keeps it.
  freeze(t: Pick<TerminalInfo, "id" | "ticket" | "harness">, sessionId: string): void {
    const objective = this.of(t);
    if (!objective) return;
    const id =
      objective.kind === "goal"
        ? objective.id
        : (objective.id ?? this.linkTicket(objective.ticket));
    this.db.run(
      "INSERT OR IGNORE INTO session_objectives (harness, session_id, objective_id) VALUES (?, ?, ?)",
      [t.harness, sessionId, id],
    );
  }

  // Every filed session and its objective, keyed `<harness>:<session id>` as the usage report
  // keys sessions.
  sessions(): Map<string, Objective> {
    const rows = this.db
      .query<Row & { harness: string; session_id: string }, []>(
        `SELECT s.harness, s.session_id, o.id, o.kind, o.ticket, o.title, o.closed_at
         FROM session_objectives s JOIN objectives o ON o.id = s.objective_id`,
      )
      .all();
    return new Map(rows.map((r) => [`${r.harness}:${r.session_id}`, objectiveOf(r)]));
  }

  private byId(id: number): Objective | null {
    const row = this.db
      .query<Row, [number]>(
        "SELECT id, kind, ticket, title, closed_at FROM objectives WHERE id = ?",
      )
      .get(id);
    return row ? objectiveOf(row) : null;
  }

  private ticketRow(ticket: string): Row | null {
    return this.db
      .query<Row, [string]>(
        "SELECT id, kind, ticket, title, closed_at FROM objectives WHERE ticket = ?",
      )
      .get(ticket);
  }

  private linkTicket(ticket: string): number {
    const found = this.ticketRow(ticket);
    if (found) return found.id;
    const row = this.db
      .query<{ id: number }, [string, string]>(
        "INSERT INTO objectives (kind, ticket, created_at) VALUES ('ticket', ?, ?) RETURNING id",
      )
      .get(ticket, now());
    return (row as { id: number }).id;
  }

  private openGoal(id: number): number {
    const found = this.byId(id);
    if (!found) throw new ObjectiveError("not_found", `no objective ${id}`);
    if (found.kind === "goal" && found.closedAt)
      throw new ObjectiveError("closed", `objective ${id} is closed`);
    return id;
  }
}

// The terminals with their objective; a change of objective is a terminals change.
export const withObjectives = (inner: Terminals, store: ObjectiveStore): Terminals =>
  decorated(
    inner,
    (t) => store.decorate(t),
    (listener) => store.subscribe(listener),
  );
