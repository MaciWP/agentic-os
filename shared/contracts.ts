import { z } from "zod";

export const ConnectionSchema = z.object({
  provider: z.enum(["atlassian", "github", "google"]),
  status: z.enum(["connected", "missing_credentials", "not_connected", "error"]),
  account: z.string().nullable(),
  detail: z.string().nullable(),
  // Jira's configured project key: the client knows a ticket key before the tickets load.
  project: z.string().optional(),
});
export type Connection = z.infer<typeof ConnectionSchema>;
