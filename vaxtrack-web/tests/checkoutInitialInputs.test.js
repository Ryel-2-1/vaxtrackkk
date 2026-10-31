import test from "node:test";
import assert from "node:assert/strict";

import { saveCartDraft } from "../src/services/orderDraftRequest.js";
import { restoreCartItems, takePlannedRequestedDate } from "../src/services/checkoutDraftRestore.js";
import { manilaToday } from "../src/services/requestedDate.js";

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

test("checkout restores only the signed-in rep's batch lines and validates quoted prices", () => {
  const storage = new MemoryStorage();
  saveCartDraft(storage, "rep-a", {
    items: [{ inventoryId: "batch-1", name: "Vaccine A", sku: "BT-1", category: "Cold Chain", quantity: 3,
      unitPriceCentavos: "tampered", vatClassification: "vatable", stock: 7 }],
  });
  assert.deepEqual(restoreCartItems(storage, "rep-b"), []);
  assert.deepEqual(restoreCartItems(storage, null), []);
  assert.deepEqual(restoreCartItems(storage, "rep-a"), [{
    inventoryId: "batch-1", name: "Vaccine A", sku: "BT-1", chain: "Cold Chain", quantity: 3,
    expectedUnitPriceCentavos: null, vatClassification: "vatable", availableNow: 7,
  }]);
});

test("the planner date is consumed once and invalid dates do not prefill checkout", () => {
  const storage = new MemoryStorage();
  const today = manilaToday(new Date());
  storage.setItem("salesRepPlannedDate", today);
  assert.equal(takePlannedRequestedDate(storage), today);
  assert.equal(takePlannedRequestedDate(storage), "");
  storage.setItem("salesRepPlannedDate", "not-a-date");
  assert.equal(takePlannedRequestedDate(storage), "");
  assert.equal(storage.getItem("salesRepPlannedDate"), null);
});
