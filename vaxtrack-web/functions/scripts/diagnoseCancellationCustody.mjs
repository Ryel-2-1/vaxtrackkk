/**
 * Cancellation custody — DIAGNOSTIC RUNNER (read-only, offline).
 *
 * Reads a JSON export and prints the cancellations that may have released
 * stock while its vials were loaded or away with a Rider. Like
 * diagnoseAllocation.mjs it has no Firebase credentials, no Admin SDK, no
 * network access and no apply mode: it cannot write to any project under any
 * flag, because there is nothing in it that could.
 *
 *   node scripts/diagnoseCancellationCustody.mjs export.json [--json]
 *
 * Input shape:
 *   { "orders":       [{ "id": "...", "data": { ... } }],
 *     "reservations": [{ "id": "<orderId>", "data": { ... } }],
 *     "returns":      [{ "id": "...", "data": { ... } }] }
 *
 * Producing the export is a separate, deliberate read-only step by an Admin
 * (e.g. a console export or an authorized read script) — not done here.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildCancellationCustodyDiagnostic,
  formatCancellationCustodyDiagnostic,
} = require("../src/cancellationCustodyDiagnostic.js");

const [, , inputPath, ...flags] = process.argv;
if (!inputPath) {
  console.error("usage: node scripts/diagnoseCancellationCustody.mjs <export.json> [--json]");
  process.exit(2);
}

const input = JSON.parse(readFileSync(inputPath, "utf8"));
for (const key of ["orders", "reservations", "returns"]) {
  if (input[key] !== undefined && !Array.isArray(input[key])) {
    console.error(`"${key}" must be an array of { id, data }.`);
    process.exit(2);
  }
}

const report = buildCancellationCustodyDiagnostic(input);
if (flags.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(formatCancellationCustodyDiagnostic(report));
}
console.log("");
console.log("No project was contacted and nothing was written. Any stock correction is a");
console.log("separate checkpoint, after a physical check, with its own authorization.");
