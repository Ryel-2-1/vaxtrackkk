"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateBatchMetadata } = require("../src/batchMetadata");

const now = new Date("2026-10-29T04:00:00Z");
const expected = { batchId: "LOT-1", manufacturingDate: "2026-01-01", expiryDate: "2027-01-01", location: "Shelf 1", manufacturer: "Maker" };

test("batch metadata accepts a complete edit and normalizes identity and text", () => {
  const result = validateBatchMetadata({ inventoryId: "batch-one", expected, ...expected, batchId: " lot-2 ", location: " Shelf 2 " }, now);
  assert.equal(result.values.batchId, "LOT-2");
  assert.equal(result.values.location, "Shelf 2");
  assert.deepEqual(result.expected, expected);
});

test("batch metadata rejects malformed dates, missing fields and unexpected writes", () => {
  assert.throws(() => validateBatchMetadata({ inventoryId: "batch-one", expected, ...expected, expiryDate: "2026-02-31" }, now));
  assert.throws(() => validateBatchMetadata({ inventoryId: "batch-one", expected, ...expected, manufacturingDate: "2026-11-01" }, now));
  assert.throws(() => validateBatchMetadata({ inventoryId: "batch-one", expected, ...expected, quantity: 99 }, now));
  assert.throws(() => validateBatchMetadata({ inventoryId: "batch-one", expected, ...expected, manufacturer: " " }, now));
});
