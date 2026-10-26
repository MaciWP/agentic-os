import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../../server/config-host.ts";

// Builds the helper apps in data/bin: AgenticMac.app, the bundle macOS grants Calendars and Mail
// automation to (scripts/mac/AgenticMac.swift), AgenticAudio.app, the one it grants System
// Audio Recording and Microphone to (scripts/mac/AgenticAudio.swift), and AgenticCapture.app,
// the one it grants Screen Recording to (scripts/mac/AgenticCapture.swift). Ad-hoc signed: every
// new build is a new identity to macOS, which asks again, so each only rebuilds when its source
// or plist changed. Names given as arguments build only those apps
// (`bun run mac:build AgenticCapture`).

const plist = (
  name: string,
  id: string,
  keys: Record<string, string>,
) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${id}</string>
  <key>CFBundleName</key><string>${name}</string>
  <key>CFBundleExecutable</key><string>${name}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
${Object.entries(keys)
  .map(([key, text]) => `  <key>${key}</key><string>${text}</string>`)
  .join("\n")}
</dict>
</plist>
`;

const APPS = [
  {
    name: "AgenticMac",
    again: "macOS will ask again for Calendars and Mail access",
    plist: plist("AgenticMac", "local.agentic-os.mac", {
      NSCalendarsFullAccessUsageDescription:
        "Agentic OS muestra tus reuniones de Outlook en Inicio. Solo lectura.",
      NSAppleEventsUsageDescription:
        "Agentic OS lee tu bandeja de Outlook en Mail y, solo cuando lo confirmas, mueve correos a tus carpetas o a Elementos eliminados.",
    }),
  },
  {
    name: "AgenticAudio",
    again: "macOS will ask again for System Audio Recording and Microphone access",
    // Without NSAudioCaptureUsageDescription the tap records silent zeros and reports no error.
    plist: plist("AgenticAudio", "local.agentic-os.audio", {
      NSAudioCaptureUsageDescription:
        "Agentic OS graba el audio de tus reuniones de Teams para transcribirlas en este Mac.",
      NSMicrophoneUsageDescription:
        "Agentic OS graba tu voz en las reuniones de Teams para transcribirlas en este Mac.",
    }),
  },
  {
    name: "AgenticCapture",
    again: "macOS will ask again for Screen Recording access",
    // Screen Recording has no usage description key: macOS names the app in its own request.
    plist: plist("AgenticCapture", "local.agentic-os.capture", {}),
  },
];

const only = process.argv.slice(2);
const unknown = only.filter((name) => !APPS.some((app) => app.name === name));
if (unknown.length) throw new Error(`unknown app: ${unknown.join(", ")}`);

function run(argv: string[]) {
  const p = Bun.spawnSync(argv, { stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) throw new Error(`${argv[0]} exited ${p.exitCode}`);
}

for (const { name, again, plist } of APPS) {
  if (only.length && !only.includes(name)) continue;
  const source = join(import.meta.dir, `${name}.swift`);
  const app = join(DATA_DIR, "bin", `${name}.app`);
  const stamp = join(app, "Contents", "Resources", "source.sha256");
  const hash = createHash("sha256").update(readFileSync(source)).update(plist).digest("hex");
  let built = "";
  try {
    built = readFileSync(stamp, "utf8").trim();
  } catch {}
  if (built === hash) {
    console.log(`${app} is current.`);
    continue;
  }
  rmSync(app, { recursive: true, force: true });
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
  writeFileSync(join(app, "Contents", "Info.plist"), plist);
  run(["swiftc", "-O", source, "-o", join(app, "Contents", "MacOS", name)]);
  run(["codesign", "--force", "--sign", "-", app]);
  writeFileSync(stamp, hash);
  console.log(`Built ${app}. ${again}: it is a new build.`);
}
