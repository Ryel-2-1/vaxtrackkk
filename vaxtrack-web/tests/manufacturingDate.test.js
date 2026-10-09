import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  NOT_RECORDED,
  STOCK_DATE_MESSAGES,
  addDaysIso,
  formatBatchDate,
  readManufacturingDate,
  validateStockBatchDates,
} from "../src/services/stockBatchDates.js";
import { buildInventoryExportRows, INVENTORY_EXPORT_HEADERS } from "../src/services/inventoryExport.js";

// Manufacturing Date on stock batches: date-only validation in Asia/Manila,
// legacy compatibility, display and export. The service-level write/no-write
// behaviour is in addStockService.test.js; the rule-level checks (create and
// coordinated date updates) are MFG1–MFG8 in the rules emulator suite.

const require = createRequire(import.meta.url);
const { evaluateBatch } = require("../functions/src/policy.js");
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const TODAY = "2026-10-05";
const base = { manufacturingDate: "2026-09-01", arrivalDate: "2026-09-10", expiryDate: "2027-09-10", todayIso: TODAY };
const check = (over) => validateStockBatchDates({ ...base, ...over });
const message = (over) => check(over).message;

test("1 · a blank manufacturing date is rejected", () => {
  for (const manufacturingDate of [undefined, null, "", "   "]) {
    assert.equal(message({ manufacturingDate }), "Enter the manufacturing date.");
  }
});

test("2/3 · malformed and impossible calendar dates are rejected", () => {
  for (const manufacturingDate of ["2026/09/01", "09-01-2026", "2026-9-1", "yesterday", "2026-02-30", "2026-13-01", "2025-02-29"]) {
    assert.equal(message({ manufacturingDate }), "Enter a valid manufacturing date.", manufacturingDate);
  }
  assert.equal(check({ manufacturingDate: "2024-02-29", arrivalDate: "2024-03-01", expiryDate: "2027-01-01" }).ok, true, "a real leap day");
});

test("4 · a manufacturing date later than today in Manila is rejected; today is allowed", () => {
  assert.equal(message({ manufacturingDate: "2026-10-06", arrivalDate: "2026-10-06" }), "Manufacturing date cannot be in the future.");
  assert.equal(check({ manufacturingDate: TODAY, arrivalDate: TODAY }).ok, true);
});

test("4 · 'today' is the Manila day, not the browser's", () => {
  // 2026-10-04T16:30Z is already 00:30 on Oct 5 in Manila. A batch made "today"
  // in Manila must pass even though the UTC calendar still says Oct 4.
  const realNow = Date.now;
  Date.now = () => Date.UTC(2026, 9, 4, 16, 30);
  try {
    const r = validateStockBatchDates({ manufacturingDate: "2026-10-05", arrivalDate: "2026-10-05", expiryDate: "2027-10-05" });
    assert.equal(r.ok, true);
    assert.equal(
      validateStockBatchDates({ manufacturingDate: "2026-10-06", arrivalDate: "2026-10-06", expiryDate: "2027-10-05" }).message,
      "Manufacturing date cannot be in the future."
    );
  } finally {
    Date.now = realNow;
  }
});

test("5 · after the arrival date is rejected", () => {
  assert.equal(message({ manufacturingDate: "2026-09-11" }), "Manufacturing date cannot be after the arrival date.");
});

test("6 · equal to the arrival date is accepted", () => {
  const r = check({ manufacturingDate: "2026-09-10" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { manufacturingDate: "2026-09-10", arrivalDate: "2026-09-10", expiryDate: "2027-09-10" });
});

test("7 · on or after the expiry date is rejected", () => {
  for (const expiryDate of ["2026-09-01", "2026-08-20"]) {
    assert.equal(message({ manufacturingDate: "2026-09-01", arrivalDate: "2026-09-05", expiryDate }), "Manufacturing date must be before the expiry date.");
  }
});

test("the exact messages agreed for the form", () => {
  assert.deepEqual(
    [
      STOCK_DATE_MESSAGES.manufacturingRequired,
      STOCK_DATE_MESSAGES.manufacturingInvalid,
      STOCK_DATE_MESSAGES.manufacturingFuture,
      STOCK_DATE_MESSAGES.manufacturingAfterArrival,
      STOCK_DATE_MESSAGES.manufacturingNotBeforeExpiry,
    ],
    [
      "Enter the manufacturing date.",
      "Enter a valid manufacturing date.",
      "Manufacturing date cannot be in the future.",
      "Manufacturing date cannot be after the arrival date.",
      "Manufacturing date must be before the expiry date.",
    ]
  );
});

test("date arithmetic is date-only (no local-time drift across month ends)", () => {
  assert.equal(addDaysIso("2026-10-31", 1), "2026-11-01");
  assert.equal(addDaysIso("2026-03-01", -1), "2026-02-28");
  assert.equal(addDaysIso(TODAY, 30), "2026-11-04");
});

// ---------------------------------------------------------------- legacy + display

test("10/11 · a legacy batch with no manufacturing date reads as Not recorded, never Invalid Date", () => {
  assert.equal(readManufacturingDate({}), null);
  assert.equal(readManufacturingDate({ manufacturingDate: "garbage" }), null);
  for (const value of [undefined, null, "", "garbage", "2026-02-31", 12345]) {
    assert.equal(formatBatchDate(value), NOT_RECORDED, String(value));
  }
  assert.equal(NOT_RECORDED, "Not recorded");
  assert.equal(formatBatchDate("2026-06-01"), "Jun 1, 2026", "the stored calendar day, unshifted");
  // The Inventory drawer uses these helpers, so a legacy row renders the label.
  const inventory = read("src/pages/admin/Inventory.jsx");
  assert.match(inventory, /manufacturing: formatBatchDate\(raw\.manufacturingDate\),/);
  assert.match(inventory, /<span>Manufacturing Date<\/span>\s*<strong>\{selectedVaccine\.manufacturing\}<\/strong>/);
});

test("12/13 · the export carries the column and leaves legacy values blank", () => {
  assert.ok(INVENTORY_EXPORT_HEADERS.includes("Manufacturing date"));
  const [withDate, legacy] = buildInventoryExportRows([
    { name: "A", manufacturingRaw: "2026-06-01", expiryRaw: "2027-01-01" },
    { name: "B", manufacturingRaw: "", expiryRaw: "2027-01-01" },
  ]);
  assert.equal(withDate.manufactured.toISOString().slice(0, 10), "2026-06-01");
  assert.equal(legacy.manufactured, null);
});

// ---------------------------------------------------------------- unchanged behaviour

test("14 · Batch ID uniqueness is still checked before saving", () => {
  const addStock = read("src/pages/admin/AddStock.jsx");
  assert.match(addStock, /if \(await batchIdExists\(cleanedBatchId\)\) \{\s*showMessage\("This Batch ID already exists in inventory\."\);/);
});

test("15 · quantity, reservation, pricing and expiry writes are unchanged", () => {
  // The client now only validates and SENDS; the batch is written by the
  // addStockBatchWithAllocation callable, which owns the stored shape.
  const svc = read("src/services/vaccineService.js");
  const fn = svc.slice(svc.indexOf("export async function addStockBatch"), svc.indexOf("export async function updateStockPrice"));
  assert.match(fn, /expiryDate: dates\.value\.expiryDate,/);
  assert.match(fn, /quantity,/);
  assert.match(fn, /sellingPriceCentavos,/);
  const code = fn.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /reservedQuantity/, "the client never sets a reserved figure");

  const server = read("functions/src/inventoryWorkflow.js");
  // Same stored fields as before: a fresh batch, priced VAT-exclusive in PHP…
  assert.match(server, /sellingPriceCentavos: input\.sellingPriceCentavos,\s*priceCurrency: "PHP",\s*priceIsVatInclusive: false,/);
  assert.match(server, /expiryDate: input\.expiryDate,\s*quantity: input\.quantity,/);
  // …whose reserved figure is exactly what the same transaction allocated from
  // it to waiting orders (0 when none were waiting).
  assert.match(server, /reservedQuantity: reservedFromNew,/);
});

test("20 · order eligibility accepts an otherwise valid legacy batch with no manufacturing date", () => {
  const legacy = {
    quantity: 100, reservedQuantity: 0, sellingPriceCentavos: 125000, status: "OK",
    expiryDate: "2027-12-31", batchId: "LEG-001", vaccineName: "Legacy Vaccine",
  };
  const result = evaluateBatch({
    inventoryId: "legacy", data: legacy, requested: 2, expectedUnitPriceCentavos: 125000,
    now: new Date("2026-10-05T02:00:00Z"),
  });
  assert.equal(result.quantity, 2);
  // And the server-side batch check does not look at the field at all.
  assert.doesNotMatch(read("functions/src/policy.js"), /manufacturingDate/);
});
