import type { Database } from "bun:sqlite";
import type { z } from "zod";
import { providerRequest } from "../../oauth.ts";
import { getAccessToken, jiraConnection, ReconnectRequired } from "./oauth.ts";

export { ISSUE_KEY } from "../../../shared/envs.ts";

export function jiraClient(db: Database) {
  async function request<S extends z.ZodType>(schema: S, path: string, init: RequestInit = {}) {
    const conn = jiraConnection(db);
    if (!conn) throw new ReconnectRequired("not connected");
    return providerRequest(
      { provider: "jira", label: "Jira", getAccessToken },
      schema,
      `https://api.atlassian.com/ex/jira/${conn.cloudId}${path}`,
      path,
      init,
    );
  }
  return { request, connection: () => jiraConnection(db) };
}

export type JiraClient = ReturnType<typeof jiraClient>;
