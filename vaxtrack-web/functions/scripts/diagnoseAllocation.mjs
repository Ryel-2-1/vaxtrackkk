/**
 * Allocation migration — DIAGNOSTIC RUNNER (read-only, offline).
 *
 * Reads a JSON export and prints the diagnostic and the PROPOSED backfill. Like
 * previewMigration.mjs it has no Firebase credentials, no Admin SDK, no
 * network access and no apply mode: it cannot write to any project under any
 * flag, because there is nothing in it that could.
 *
 *   node scripts/diagnoseAllocation.mjs export.json [--json]
 *
 * Input shape:
 *   { "inventory":    [{ "id": "...", "data": { ... } }],
 *     "orders":       [{ "id": "...", "data": { ... } }],
 *     "reservations": [{ "id": "<orderId>", "data": { ... } }],
 *     "returns":      [{ "id": "...", "data": { ... } }] }
 *
 * Producing the export is a separate, deliberate read-only step by an Admin
 * (e.g. a console export or an authorized read script) — not done here.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildAllocationDiagnostic, formatAllocationDiagnostic } = require("../src/allocationMigration.js");

const [, , inputPath, ...flags] = process.argv;
if (!inputPath) {
  console.error("usage: node scripts/diagnoseAllocation.mjs <export.json> [--json]");
  process.exit(2);
}

const input = JSON.parse(readFileSync(inputPath, "utf8"));
for (const key of ["inventory", "orders", "reservations", "returns"]) {
  if (input[key] !== undefined && !Array.isArray(input[key])) {
    console.error(`"${key}" must be an array of { id, data }.`);
    process.exit(2);
  }
}

const report = buildAllocationDiagnostic(input);
if (flags.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(formatAllocationDiagnostic(report));
}
console.log("");
console.log("No project was contacted and nothing was written. Applying any proposal");
console.log("is a separate checkpoint with its own authorization.");
