/**
 * Inventory quantity migration — PREVIEW RUNNER.
 *
 * Reads a JSON file of inventory documents and prints the plan. It has no
 * Firebase credentials, no Admin SDK, no network access and no apply mode: it
 * cannot write to any project under any flag, because there is nothing in it
 * that could. Producing the input is a separate, deliberate read-only export.
 *
 *   node scripts/previewMigration.mjs fixtures/staging-inventory.json
 *
 * Input shape: [{ id, data: { quantity, batchId, ... }, hasReservations }]
 * `hasReservations` must come from a real query of inventoryReservations —
 * `reservedQuantity: 0` is only ever proposed for a batch nothing has claimed.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildMigrationPlan, formatMigrationPlan } = require("../src/migrationPreview.js");

const [, , inputPath] = process.argv;
if (!inputPath) {
  console.error("usage: node scripts/previewMigration.mjs <documents.json>");
  process.exit(2);
}

const documents = JSON.parse(readFileSync(inputPath, "utf8"));
if (!Array.isArray(documents)) {
  console.error("Input must be an array of { id, data, hasReservations }.");
  process.exit(2);
}

const plan = buildMigrationPlan(documents);
console.log(formatMigrationPlan(plan));
console.log("");
console.log("No project was contacted and nothing was written. Applying a plan");
console.log("is a separate checkpoint with its own authorization.");
