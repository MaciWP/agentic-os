import type { z } from "zod";

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    message: string,
    // The provider's machine reason (Google's `errors[0].reason`), for retry decisions on this
    // server only; it never reaches a client.
    readonly reason?: string,
  ) {
    super(message);
  }
}
// Why a fetch never got an answer: Bun's code (ConnectionRefused, ENOTFOUND, ECONNRESET…)
// says more than the error's class, which is always TypeError.
export function netCause(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code) return code;
  return err instanceof Error ? err.name : String(err);
}

// Never attach upstream values or validation issues to a client-visible shape error.
export function parseProvider<S extends z.ZodType>(
  provider: string,
  schema: S,
  value: unknown,
): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ProviderError(provider, 502, `${provider} response changed shape`);
  return parsed.data;
}
