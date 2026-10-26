// What a caught value says, for logs and error bodies: `(err as Error).message` would give
// `undefined` when a library rejects with a string or a plain object.
export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);
