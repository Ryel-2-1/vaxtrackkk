// Runs every web unit test under node:test, skipping the two Security Rules
// suites — those need the Firebase emulators and run via `npm run test:rules`
// and `npm run test:storage-rules` instead (CI has a separate job for them).
//
// A script rather than a shell glob so it behaves the same under cmd, PowerShell
// and bash.

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const EMULATOR_SUITES = new Set(["firestore.rules.test.js", "storage.rules.test.js"]);

const files = readdirSync("tests")
  .filter((name) => name.endsWith(".test.js") && !EMULATOR_SUITES.has(name))
  .sort()
  .map((name) => `tests/${name}`);

if (files.length === 0) {
  console.error("No unit test files found under tests/.");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
