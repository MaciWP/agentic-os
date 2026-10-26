import { z } from "zod";

const Id = z
  .string()
  .min(1)
  .max(300)
  .refine((s) => !/[\p{Cc}\p{Cf}]/u.test(s));
export const MesaName = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u);
// Panels (a checkout's git view, an env's output, a file, a recorded meeting) may sit in
// several Mesas; a terminal sits in one at most.
export const isPanelId = (id: string) => /^(git|job|code|rec):/.test(id);
export const MAX_MEMBERS = 6;
export const SharedMesa = z.object({
  id: Id,
  name: MesaName,
  ids: z.array(Id).max(MAX_MEMBERS),
  // The work block the Mesa sits in; none puts it in the trailing «Sin bloque» group.
  block: Id.optional(),
});
export type SharedMesa = z.infer<typeof SharedMesa>;
// A work block groups Mesas in the tab bar («Trabajo», «Personal»…). Its order is the bar's.
export const BLOCK_COLORS = ["slate", "blue", "green", "amber", "rose", "violet"] as const;
export const BlockColor = z.enum(BLOCK_COLORS);
export type BlockColor = z.infer<typeof BlockColor>;
export const MAX_BLOCKS = 20;
export const SharedBlock = z.object({ id: Id, name: MesaName, color: BlockColor });
export type SharedBlock = z.infer<typeof SharedBlock>;
export const SharedBlocks = z
  .array(SharedBlock)
  .max(MAX_BLOCKS)
  .refine((blocks) => new Set(blocks.map((b) => b.id)).size === blocks.length, "duplicate block");
export const SharedMesas = z
  .array(SharedMesa)
  .min(1)
  .max(100)
  .superRefine((mesas, ctx) => {
    const names = new Set<string>();
    const terminals = new Set<string>();
    for (const m of mesas) {
      if (names.has(m.id) || new Set(m.ids).size !== m.ids.length)
        ctx.addIssue({ code: "custom", message: "duplicate mesa or tile" });
      names.add(m.id);
      for (const id of m.ids) {
        if (isPanelId(id)) continue;
        if (terminals.has(id))
          ctx.addIssue({ code: "custom", message: "terminal belongs to two mesas" });
        terminals.add(id);
      }
    }
  });
export const WorkspaceSnapshot = z.object({
  revision: z.number().int().nonnegative(),
  mesas: z.union([SharedMesas, z.array(SharedMesa).length(0)]),
  // Snapshots stored before blocks existed have none.
  blocks: SharedBlocks.default([]),
});
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshot>;
// What the user asked for, about one tile or one Mesa. The server applies it to its current
// state, so intents from two devices never refuse each other for a stale revision. No command
// sets a Mesa's members wholesale: that would drop a tile another device just added.
export const WorkspaceIntent = z.discriminatedUnion("kind", [
  // Put a tile in a Mesa; refused when the terminal already sits in another one.
  z.object({ kind: z.literal("add"), mesa: Id, tile: Id }),
  z.object({ kind: z.literal("remove"), mesa: Id, tile: Id }),
  // Take a terminal from wherever it is into this Mesa.
  z.object({ kind: z.literal("move"), mesa: Id, tile: Id }),
  // A new Mesa, with the terminal dropped on it moved in.
  // A new Mesa, with the terminal dropped on it moved in, in the block it was made from.
  z.object({
    kind: z.literal("create"),
    mesa: Id,
    name: MesaName,
    tile: Id.optional(),
    block: Id.optional(),
  }),
  z.object({ kind: z.literal("close"), mesa: Id }),
  z.object({ kind: z.literal("rename"), mesa: Id, name: MesaName }),
  // Put a Mesa in a block, or (null) in none.
  z.object({ kind: z.literal("assign"), mesa: Id, block: Id.nullable() }),
  // A new block, with these Mesas moved into it (the «Organizar» proposal sends one per block).
  z.object({
    kind: z.literal("block-create"),
    block: Id,
    name: MesaName,
    color: BlockColor,
    mesas: z.array(Id).max(100).optional(),
  }),
  z.object({
    kind: z.literal("block-update"),
    block: Id,
    name: MesaName.optional(),
    color: BlockColor.optional(),
  }),
  // A removed block's Mesas stay, without a block.
  z.object({ kind: z.literal("block-remove"), block: Id }),
  z.object({ kind: z.literal("block-move"), block: Id, index: z.number().int().nonnegative() }),
]);
export type WorkspaceIntent = z.infer<typeof WorkspaceIntent>;
export const WorkspaceCommand = z.object({
  requestId: z.string().uuid(),
  // Checked for an import; an intent ignores it.
  expectedRevision: z.number().int().nonnegative().optional(),
  action: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("import"), mesas: SharedMesas, blocks: SharedBlocks.default([]) }),
    z.object({ kind: z.literal("intent"), intent: WorkspaceIntent }),
  ]),
});
export type WorkspaceCommand = z.infer<typeof WorkspaceCommand>;

export function membership(mesas: SharedMesa[]): SharedMesa[] {
  return mesas.map(({ id, name, ids, block }) => ({ id, name, ids, ...(block && { block }) }));
}
