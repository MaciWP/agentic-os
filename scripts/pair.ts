// pair: run once on a worker (the PC). It makes a new pairing token, keeps only its hash in the
// data folder and prints the token once, to paste into the hub's «Emparejar». Running it again
// replaces the pairing: the hub needs the new token.
import { DATA_DIR } from "../server/config.ts";
import { newPairing } from "../server/features/system/update.ts";

// On Windows the worker's data lives beside the app, never in the default: the pairing must
// land in the folder the running worker reads.
if (process.platform === "win32" && !process.env.AGENTIC_OS_DATA) {
  console.error("Falta AGENTIC_OS_DATA: ponlo a la carpeta data del worker y vuelve a ejecutarlo.");
  process.exit(1);
}
const token = await newPairing(DATA_DIR);
console.log(`Emparejamiento guardado en ${DATA_DIR}`);
console.log(`Token de emparejamiento (pégalo en la web del Mac, «Emparejar»):\n\n${token}\n`);
