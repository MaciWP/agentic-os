// Usage: bun run secrets:set <name>   (hidden prompt)
//        pbpaste | bun run secrets:set <name>
import { isSecretName, SECRET_NAMES, setSecret } from "../server/secrets.ts";

async function readHidden(label: string): Promise<string> {
  process.stdout.write(`${label}: `);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = "";
  for await (const chunk of process.stdin) {
    for (const ch of String(chunk)) {
      if (ch === "\r" || ch === "\n") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        return value;
      }
      if (ch === "\u0003") process.exit(130);
      if (ch === "\u007f") value = value.slice(0, -1);
      else value += ch;
    }
  }
  return value;
}

const name = process.argv[2] ?? "";
if (!isSecretName(name)) {
  console.error(`Usage: bun run secrets:set <${SECRET_NAMES.join("|")}>`);
  process.exit(2);
}
const value = (process.stdin.isTTY ? await readHidden(name) : await Bun.stdin.text()).trim();
if (!value) {
  console.error("Empty value; nothing stored.");
  process.exit(1);
}
await setSecret(name, value);
console.log(`Stored ${name} in the Keychain (${value.length} chars).`);
