import type { Client, TerminalInfo, Terminals } from "./contract.ts";

// The terminals with what the server adds to each one it lists (agent state, objective), and
// that addition's changes as terminal changes. Everything else goes to `inner`.
export function decorated(
  inner: Terminals,
  decorate: (t: TerminalInfo) => TerminalInfo,
  changes: (listener: () => void) => () => void,
): Terminals {
  return {
    consultations: inner.consultations,
    get env() {
      return inner.env;
    },
    list: async () => (await inner.list()).map(decorate),
    get: async (id) => {
      const t = await inner.get(id);
      return t && decorate(t);
    },
    subscribe: (listener) => {
      const offInner = inner.subscribe(listener);
      const offOwn = changes(listener);
      return () => {
        offInner();
        offOwn();
      };
    },
    pids: () => inner.pids(),
    create: (spec) => inner.create(spec),
    launchStatus: inner.launchStatus?.bind(inner),
    createEnv: (req, size) => inner.createEnv(req, size),
    runEnv: (req, size) => inner.runEnv(req, size),
    attach: (id, client: Client, take) => inner.attach(id, client, take),
    detach: (id, client) => inner.detach(id, client),
    input: (id, client, data) => inner.input(id, client, data),
    resize: (id, client, cols, rows) => inner.resize(id, client, cols, rows),
    resume: (id) => inner.resume(id),
    restart: (id) => inner.restart(id),
    read: (id, lines) => inner.read(id, lines),
    write: (id, data, opts) => inner.write(id, data, opts),
    waitFor: (id, opts) => inner.waitFor(id, opts),
    stop: (id) => inner.stop(id),
    remove: (id) => inner.remove(id),
    rename: (id, name) => inner.rename(id, name),
  };
}
