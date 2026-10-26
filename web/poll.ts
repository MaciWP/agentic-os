// A query's refetchInterval that backs off while its last read failed: a server or a worker
// that is down is asked `slowBy` times less often, and the normal pace comes back with the
// first answer.
export const pollEvery =
  (ms: number, slowBy = 6) =>
  (query: { state: { status: string } }) =>
    query.state.status === "error" ? ms * slowBy : ms;
