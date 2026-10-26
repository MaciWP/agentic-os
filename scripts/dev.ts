// Both children belong to this command. Exiting Vite must not strand a watch server.
const env = { ...process.env, NODE_ENV: "development" };
const commands = [
  [process.execPath, "--watch", "server/index.ts"],
  [process.execPath, "node_modules/vite/bin/vite.js"],
];
const children = commands.map((cmd) =>
  Bun.spawn(cmd, { env, stdin: "ignore", stdout: "inherit", stderr: "inherit" }),
);
let stopping = false;
async function stop(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  await Promise.all(children.map((child) => child.exited));
  process.exitCode = code;
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void stop(0));
void Promise.race(children.map((child) => child.exited)).then((code) => stop(code));
