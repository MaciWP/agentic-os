import { z } from "zod";
import { ISSUE_KEY } from "./envs.ts";

// What a terminal works on (server/features/objectives): a Jira ticket or a free-text goal.
export const Objective = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ticket"), id: z.number().int().nullable(), ticket: z.string() }),
  z.object({
    kind: z.literal("goal"),
    id: z.number().int(),
    title: z.string(),
    closedAt: z.string().nullable(),
  }),
]);
export type Objective = z.infer<typeof Objective>;

// A local date and a time of day, as the user means them: no zone travels.
export const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

// A goal as a task of the day on Inicio: open, or closed (done) at `closedAt`. `dueOn` hides
// it until that day; `position` is the user's order; `source` + `sourceKey` name what made it
// (`mail:outlook` + a Message-ID, `note:<id>` + a line hash), so it is made once.
export const Task = z.object({
  id: z.number().int(),
  title: z.string(),
  createdAt: z.string(),
  closedAt: z.string().nullable(),
  dueOn: z.string().nullable(),
  dueHm: z.string().nullable(),
  priority: z.union([z.literal(0), z.literal(1)]),
  position: z.number().nullable(),
  about: z.string().nullable(),
  source: z.string().nullable(),
  sourceKey: z.string().nullable(),
});
export type Task = z.infer<typeof Task>;

// One local day as the browser sees it: [from, to) and its date.
export const TaskDay = z.strictObject({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  day: z.string().regex(DAY),
});

export const GoalTitle = z.string().trim().min(1).max(200);

// What a task may say beyond its title. A time needs a day.
const TaskFields = {
  dueOn: z.string().regex(DAY).nullable().optional(),
  dueHm: z.string().regex(HM).nullable().optional(),
  priority: z.union([z.literal(0), z.literal(1)]).optional(),
  about: z.string().trim().min(1).max(200).nullable().optional(),
};
const timeNeedsDay = (t: { dueOn?: string | null; dueHm?: string | null }) =>
  !t.dueHm || Boolean(t.dueOn);

// What made a task: `mail:outlook`, `mail:gmail`, `meeting:<id>`.
export const TaskSource = z
  .string()
  .regex(/^[a-z]+:[a-z0-9-]+$/)
  .max(60);

export const NewGoal = z
  .strictObject({
    title: GoalTitle,
    ...TaskFields,
    source: TaskSource.optional(),
    sourceKey: z.string().min(1).max(300).optional(),
  })
  .refine((g) => (g.source === undefined) === (g.sourceKey === undefined), {
    message: "source and sourceKey go together",
  })
  .refine(timeNeedsDay, { message: "a time needs a day" });
export type NewGoal = z.infer<typeof NewGoal>;

// Several tasks at once, from a meeting note's checklist.
export const NewGoals = z.strictObject({ goals: z.array(NewGoal).min(1).max(50) });

export const GoalPatch = z
  .strictObject({
    title: GoalTitle.optional(),
    position: z.number().finite().optional(),
    ...TaskFields,
  })
  .refine((p) => Object.keys(p).length > 0, { message: "nothing to change" });
export type GoalPatch = z.infer<typeof GoalPatch>;

// A terminal's objective as the user sets it: a ticket, an objective by id, none, or back to
// the ticket it was launched with.
export const ObjectiveChoice = z.union([
  z.strictObject({ ticket: z.string().regex(ISSUE_KEY) }),
  z.strictObject({ objective: z.number().int().positive() }),
  z.strictObject({ none: z.literal(true) }),
  z.strictObject({ launch: z.literal(true) }),
]);
export type ObjectiveChoice = z.infer<typeof ObjectiveChoice>;

// The key the usage report files an objective's work under: the ticket key, or goal:<id>.
export const objectiveKey = (o: Objective) => (o.kind === "ticket" ? o.ticket : `goal:${o.id}`);

// A goal's key in the usage report and in the Consumo URL.
export const GOAL_KEY = /^goal:\d+$/;

// How every list names it.
export const objectiveLabel = (o: Objective) => (o.kind === "ticket" ? o.ticket : o.title);
