import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  isPanelId,
  MAX_BLOCKS,
  MAX_MEMBERS,
  type SharedBlock,
  SharedBlocks,
  type SharedMesa,
  SharedMesas,
  WorkspaceCommand,
  type WorkspaceIntent,
  WorkspaceSnapshot,
} from "../../../shared/workspace.ts";
import { log } from "../../log.ts";
import { contentVersion } from "../../recovery.ts";
import { keptSince } from "../../retention.ts";

// A command the workspace refused; `current` is the state after the refusal, which the client
// takes as its own and tells the user why.
export class WorkspaceConflict extends Error {
  constructor(
    code: string,
    readonly current?: WorkspaceSnapshot,
  ) {
    super(code);
  }
}
type Shared = { mesas: SharedMesa[]; blocks: SharedBlock[] };
// The Mesas and blocks after one intent, from the current ones. Repeating an intent changes
// nothing, so a retried request or one that crossed another always lands on the same state.
export function applyIntent(state: Shared, intent: WorkspaceIntent): Shared {
  const next = state.mesas.map((m) => ({ ...m, ids: [...m.ids] }));
  let blocks = state.blocks.map((b) => ({ ...b }));
  const block = (id: string) => {
    const found = blocks.find((b) => b.id === id);
    if (!found) throw new WorkspaceConflict("block_missing");
    return found;
  };
  const done = () => ({ mesas: next, blocks });
  if (intent.kind === "block-create") {
    if (!blocks.some((b) => b.id === intent.block)) {
      if (blocks.length >= MAX_BLOCKS) throw new WorkspaceConflict("blocks_full");
      blocks.push({ id: intent.block, name: intent.name, color: intent.color });
    }
    for (const m of next) if (intent.mesas?.includes(m.id)) m.block = intent.block;
    return done();
  }
  if (intent.kind === "block-update") {
    const b = block(intent.block);
    if (intent.name) b.name = intent.name;
    if (intent.color) b.color = intent.color;
    return done();
  }
  if (intent.kind === "block-remove") {
    blocks = blocks.filter((b) => b.id !== intent.block);
    for (const m of next) if (m.block === intent.block) delete m.block;
    return done();
  }
  if (intent.kind === "block-move") {
    const moved = block(intent.block);
    const rest = blocks.filter((b) => b !== moved);
    rest.splice(Math.min(intent.index, rest.length), 0, moved);
    blocks = rest;
    return done();
  }
  const target = next.find((m) => m.id === intent.mesa);
  const put = (m: SharedMesa, tile: string) => {
    if (m.ids.includes(tile)) return;
    if (m.ids.length >= MAX_MEMBERS) throw new WorkspaceConflict("mesa_full");
    m.ids.push(tile);
  };
  const moveIn = (m: SharedMesa, tile: string) => {
    if (!isPanelId(tile))
      for (const other of next) if (other !== m) other.ids = other.ids.filter((x) => x !== tile);
    put(m, tile);
  };
  switch (intent.kind) {
    case "add": {
      if (!target) throw new WorkspaceConflict("mesa_missing");
      const owner = next.find((m) => m !== target && m.ids.includes(intent.tile));
      if (owner && !isPanelId(intent.tile)) throw new WorkspaceConflict("terminal_elsewhere");
      put(target, intent.tile);
      return done();
    }
    case "remove":
      if (target) target.ids = target.ids.filter((x) => x !== intent.tile);
      return done();
    case "move":
      if (!target) throw new WorkspaceConflict("mesa_missing");
      moveIn(target, intent.tile);
      return done();
    case "create": {
      // A block removed meanwhile only loses the grouping, never the new Mesa.
      const into = intent.block && blocks.some((b) => b.id === intent.block) ? intent.block : null;
      const mesa: SharedMesa = target ?? {
        id: intent.mesa,
        name: intent.name,
        ids: [],
        ...(into && { block: into }),
      };
      if (!target) next.push(mesa);
      if (intent.tile) moveIn(mesa, intent.tile);
      return done();
    }
    case "close": {
      const rest = next.filter((m) => m !== target);
      // Like the browser's closeMesa: the last Mesa closed leaves an empty «Mesa 1».
      return { mesas: rest.length ? rest : [{ id: "mesa-1", name: "Mesa 1", ids: [] }], blocks };
    }
    case "rename":
      if (!target) throw new WorkspaceConflict("mesa_missing");
      target.name = intent.name;
      return done();
    case "assign":
      if (!target) throw new WorkspaceConflict("mesa_missing");
      if (intent.block === null) delete target.block;
      else target.block = block(intent.block).id;
      return done();
  }
}

// The stored body: the bare Mesas array from before blocks, or both.
const Body = z.union([
  z.array(z.unknown()).transform((mesas) => ({ mesas, blocks: [] })),
  z.object({ mesas: z.array(z.unknown()), blocks: z.array(z.unknown()) }),
]);

export class WorkspaceStore {
  constructor(
    private db: Database,
    private changed: () => void = () => {},
  ) {}
  read(): WorkspaceSnapshot {
    const row = this.db
      .query<{ revision: number; body: string }, []>(
        "SELECT revision,body FROM workspace_state WHERE id=1",
      )
      .get();
    return row
      ? WorkspaceSnapshot.parse({ revision: row.revision, ...Body.parse(JSON.parse(row.body)) })
      : { revision: 0, mesas: [], blocks: [] };
  }
  apply(raw: z.input<typeof WorkspaceCommand>) {
    const command = WorkspaceCommand.parse(raw);
    const hash = contentVersion(JSON.stringify(command));
    let modified = false;
    const run = this.db.transaction(() => {
      const duplicate = this.db
        .query<{ fingerprint: string; result: string }, [string]>(
          "SELECT fingerprint,result FROM workspace_requests WHERE request_id=?",
        )
        .get(command.requestId);
      if (duplicate) {
        if (duplicate.fingerprint !== hash) throw new WorkspaceConflict("request_conflict");
        return WorkspaceSnapshot.parse(JSON.parse(duplicate.result));
      }
      const current = this.read();
      if (command.action.kind !== "intent" && current.revision !== command.expectedRevision)
        throw new WorkspaceConflict("workspace_changed");
      let state: Shared = { mesas: current.mesas, blocks: current.blocks };
      if (command.action.kind === "intent") {
        // Before the first import there is nothing to act on.
        if (current.revision === 0) throw new WorkspaceConflict("workspace_empty");
        state = applyIntent(state, command.action.intent);
      } else {
        if (current.revision !== 0) throw new WorkspaceConflict("already_initialized");
        state = { mesas: command.action.mesas, blocks: command.action.blocks };
      }
      const mesas = SharedMesas.safeParse(state.mesas);
      const blocks = SharedBlocks.safeParse(state.blocks);
      if (!mesas.success || !blocks.success) throw new WorkspaceConflict("membership_conflict");
      const known = new Set(blocks.data.map((b) => b.id));
      if (mesas.data.some((m) => m.block && !known.has(m.block)))
        throw new WorkspaceConflict("block_missing");
      // An intent that changes nothing keeps the revision; an import always moves it.
      const same =
        command.action.kind === "intent" &&
        JSON.stringify(mesas.data) === JSON.stringify(current.mesas) &&
        JSON.stringify(blocks.data) === JSON.stringify(current.blocks);
      const result = same
        ? current
        : { revision: current.revision + 1, mesas: mesas.data, blocks: blocks.data };
      if (!same)
        this.db.run(
          "INSERT INTO workspace_state VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,body=excluded.body",
          [result.revision, JSON.stringify({ mesas: result.mesas, blocks: result.blocks })],
        );
      this.db.run("DELETE FROM workspace_requests WHERE created_at < ?", [keptSince()]);
      this.db.run(
        "INSERT INTO workspace_requests (request_id,fingerprint,result,created_at) VALUES (?,?,?,?)",
        [command.requestId, hash, JSON.stringify(result), new Date().toISOString()],
      );
      modified = !same;
      return result;
    });
    let result: WorkspaceSnapshot;
    try {
      result = run.immediate();
    } catch (err) {
      // Read after the rollback: the state the refused command met.
      if (err instanceof WorkspaceConflict) throw new WorkspaceConflict(err.message, this.read());
      throw err;
    }
    if (modified) {
      try {
        this.changed();
      } catch (error) {
        log("workspace").error("notification failed", { err: error });
      }
    }
    return result;
  }
}
