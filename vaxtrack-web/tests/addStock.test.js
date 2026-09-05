import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Admin → Add New Stock.
//
// Storage Temperature is no longer collected or written; the decorative
// "2. Batch Details" step tab is gone; and the workflow's real guarantees —
// Firestore-sourced vaccines, authoritative document identity, batch-id and
// quantity validation, one-write-at-a-time, safe empty state — are pinned here.
//
// Source-shape assertions: this repo has no jsdom/RTL and adding one would be a
// dependency change, matching the other suites here.

const here = dirname(fileURLToPath(import.meta.url));
const src = (...p) => readFileSync(join(here, "..", "src", ...p), "utf8");

const addStock = src("pages", "admin", "AddStock.jsx");
const vaccineService = src("services", "vaccineService.js");
const adminInventory = src("pages", "admin", "Inventory.jsx");
const salesRepInventory = src("pages", "salesRep", "SalesRepInventory.jsx");
const salesRepRequest = src("pages", "salesRep", "SalesRepRequestOrder.jsx");

// ---------------------------------------------------------------------------
// Storage Temperature is gone
// ---------------------------------------------------------------------------

test("Add Stock has no storage temperature field, state or validation", () => {
  for (const marker of [
    "storageTemp",
    "storageTempDisplay",
    "Storage Temperature",
    "isValidTemperature",
    "°C",
  ]) {
    assert.ok(!addStock.includes(marker), `${marker} must be gone`);
  }
});

test("the stock service neither accepts nor writes a temperature", () => {
  const start = vaccineService.indexOf("export async function addStockBatch");
  assert.notEqual(start, -1);
  const rest = vaccineService.slice(start);
  const next = rest.search(/\nexport (async )?function /);
  const fn = next === -1 ? rest : rest.slice(0, next);

  assert.ok(!fn.includes("storageTemp"), "no temperature parameter or field");
  // Writing a placeholder would be worse than omitting: it would read as a real
  // cold-chain figure.
  assert.ok(!fn.includes("storageTempDisplay"));
  assert.doesNotMatch(fn, /storageTemp:\s*(null|""|0)/);
});

test("legacy inventory documents with a temperature stay readable", () => {
  // Nothing migrates or rewrites them; every reader falls back to a dash when
  // the field is absent, so old batches keep showing their recorded value and
  // new ones simply show none.
  assert.match(
    adminInventory,
    /raw\.storageTempDisplay \|\| \(raw\.storageTemp != null/,
    "Admin Inventory must still read legacy temperatures"
  );
  assert.match(
    salesRepInventory,
    /raw\.storageTempDisplay \|\| \(raw\.storageTemp != null/
  );
  assert.match(salesRepRequest, /raw\.storageTemp != null/);
  for (const reader of [adminInventory, salesRepInventory, salesRepRequest]) {
    assert.match(reader, /"—"/, "absence must degrade to a dash");
  }
});

// ---------------------------------------------------------------------------
// The redundant top element is gone
// ---------------------------------------------------------------------------

test("the decorative step strip and its Batch Details tab are gone", () => {
  assert.ok(!addStock.includes("step-tabs"), "the step strip must be removed");
  assert.ok(
    !addStock.includes("2. Batch Details"),
    "the redundant Batch Details tab must be removed"
  );
  assert.ok(!addStock.includes("1. Product Information"));
});

test("the real sections and batch fields are preserved", () => {
  assert.match(addStock, /Product Identification/, "section heading kept");
  assert.match(addStock, /Logistics &amp; Quantity|Logistics & Quantity/);
  assert.match(addStock, />\s*Batch ID\s*</);
  assert.match(addStock, />\s*Arrival Date\s*</);
  assert.match(addStock, />\s*Expiry Date\s*</);
  assert.match(addStock, />\s*Unit Quantity \(Doses\)\s*</);
});

// ---------------------------------------------------------------------------
// Vaccine identity and metadata
// ---------------------------------------------------------------------------

test("registered vaccines come from Firestore, not hard-coded options", () => {
  assert.match(addStock, /getVaccines\(\)/);
  assert.match(
    addStock,
    /vaccines\.map\(\(vaccine\) => \([\s\S]*?value=\{vaccine\.id\}/,
    "options must be rendered from the loaded documents"
  );
  assert.match(vaccineService, /collection\(db, VACCINES\)/);
});

test("the vaccine document id is authoritative and never shadowed", () => {
  assert.match(
    vaccineService,
    /getVaccines[\s\S]*?\.map\(\(d\) => \(\{ \.\.\.d\.data\(\), id: d\.id \}\)\)/,
    "document id must be assigned after the spread"
  );
  assert.doesNotMatch(
    vaccineService,
    /getVaccines[\s\S]*?\{\s*id: d\.id,\s*\.\.\.d\.data\(\)\s*\}[\s\S]*?batchIdExists/,
    "the shadowable ordering must not return in getVaccines"
  );
});

test("document id is not conflated with SKU, name or batch id", () => {
  // vaccineId is the document id; internalSku is the business SKU; batchId is
  // the operator's batch reference. Three distinct values.
  assert.match(addStock, /vaccineId: selectedVaccine\.id/);
  assert.match(addStock, /internalSku: selectedVaccine\.internalSku/);
  assert.match(addStock, /batchId: cleanedBatchId/);
  assert.doesNotMatch(addStock, /vaccineId: selectedVaccine\.internalSku/);
  assert.doesNotMatch(addStock, /internalSku: selectedVaccine\.id/);
});

test("manufacturer comes from the selected vaccine and is never fabricated", () => {
  assert.match(
    addStock,
    /setManufacturer\(vaccine\.manufacturer \|\| ""\)/,
    "populated from the vaccine, blank when it has none"
  );
  assert.match(addStock, /setManufacturer\(""\)/, "cleared when deselected");
  assert.match(addStock, /manufacturer: cleanedManufacturer/);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("batch id is trimmed, required and duplicate-checked", () => {
  assert.match(addStock, /batchId\.trim\(\)\.toUpperCase\(\)/);
  assert.match(addStock, /Batch ID is required/);
  assert.match(
    addStock,
    /await batchIdExists\(cleanedBatchId\)/,
    "must use the existing authoritative duplicate check"
  );
  assert.match(addStock, /already exists in inventory/);
});

test("quantity must be a positive whole number and is not pre-filled", () => {
  assert.match(
    addStock,
    /useState\(""\)/,
    "quantity must start empty rather than with an invented figure"
  );
  assert.match(addStock, /Unit quantity is required/);
  assert.match(addStock, /Number\.isInteger\(quantityNumber\)/);
  assert.match(addStock, /quantityNumber <= 0/);
});

test("arrival and expiry dates are validated and ordered", () => {
  assert.match(addStock, /Arrival date is required/);
  assert.match(addStock, /Expiry date is required/);
  assert.match(addStock, /Arrival date is invalid/);
  assert.match(addStock, /Expiry date is invalid/);
  assert.match(addStock, /expiry <= arrival/, "expiry must be after arrival");
  assert.match(addStock, /Expiry date must be after the arrival date/);
});

// ---------------------------------------------------------------------------
// Submission behaviour
// ---------------------------------------------------------------------------

test("submission goes through the service boundary, not raw Firestore", () => {
  assert.match(addStock, /await addStockBatch\(\{/);
  for (const forbidden of ["addDoc", "setDoc", "collection(db", "firebase/firestore"]) {
    assert.ok(
      !addStock.includes(forbidden),
      `${forbidden} must not appear in the page`
    );
  }
});

test("duplicate submissions are blocked while a write is in flight", () => {
  // `saving` alone is insufficient: it is set after an async Firestore
  // duplicate-check, so a second submit could slip in behind it.
  assert.match(addStock, /const submittingRef = useRef\(false\)/);
  assert.match(
    addStock,
    /if \(submittingRef\.current\) return;\s*\n\s*submittingRef\.current = true;/,
    "the guard must be set synchronously, before any await"
  );
  assert.match(addStock, /submittingRef\.current = false;/, "and released");
});

test("success navigates back to Admin Inventory; Cancel writes nothing", () => {
  assert.match(addStock, /navigate\("\/admin\/inventory"\)/);
  assert.match(addStock, /Stock added successfully/);

  // Cancel is a plain button that only navigates.
  assert.match(
    addStock,
    /type="button"[\s\S]{0,120}onClick=\{\(\) => navigate\("\/admin\/inventory"\)\}[\s\S]{0,120}Cancel/,
    "Cancel must only navigate"
  );
});

test("loading, empty, error and success states all exist", () => {
  assert.match(addStock, /Loading vaccines\.\.\./);
  assert.match(addStock, /No vaccines are registered yet/);
  assert.match(addStock, /Failed to add stock/);
  assert.match(addStock, /Unable to load registered vaccines/);
  assert.match(addStock, /saving \? "Adding\.\.\." : "\+ Add Stock"/);
});

test("the empty state points at Register New Vaccine without creating one", () => {
  assert.match(addStock, /Register New Vaccine/);
  assert.match(addStock, /navigate\("\/admin\/add-vaccine"\)/);
  // Nothing may auto-create a vaccine from this page.
  assert.ok(!addStock.includes("addVaccine("));
  assert.ok(!addStock.includes("addVaccineType("));
});

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

test("every field has an associated label", () => {
  const pairs = [
    ["stock-vaccine", "Registered Vaccine"],
    ["stock-manufacturer", "Manufacturer"],
    ["stock-batch-id", "Batch ID"],
    ["stock-arrival-date", "Arrival Date"],
    ["stock-expiry-date", "Expiry Date"],
    ["stock-quantity", "Unit Quantity"],
  ];
  for (const [id, label] of pairs) {
    assert.match(
      addStock,
      new RegExp(`htmlFor="${id}"`),
      `${label} needs a htmlFor`
    );
    assert.match(addStock, new RegExp(`id="${id}"`), `${label} needs an id`);
  }
});

test("messages are announced and stepper buttons are named", () => {
  assert.match(addStock, /aria-live="assertive"/);
  assert.match(addStock, /role=\{messageType === "success" \? "status" : "alert"\}/);
  assert.match(addStock, /aria-label="Decrease quantity by 100"/);
  assert.match(addStock, /aria-label="Increase quantity by 100"/);
});

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

test("Register New Vaccine behaviour is untouched", () => {
  const addVaccine = src("pages", "admin", "AddVaccine.jsx");
  assert.match(addVaccine, /skuExists\(/);
  assert.match(addVaccine, /addVaccine\(/);
  assert.match(addVaccine, /navigate\("\/admin\/inventory"\)/);
});

test("the Inventory subscription remains the source of truth", () => {
  assert.match(adminInventory, /subscribeInventory\(/);
  const calls = adminInventory.match(/setInventory\(/g) ?? [];
  assert.ok(calls.length >= 1, "inventory list still comes from the snapshot");
});
