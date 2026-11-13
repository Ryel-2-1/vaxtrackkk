import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { invoiceLotText, invoiceLotsNeedSave } from "../src/services/invoiceModel.js";
import { buildInvoiceWorksheet } from "../src/services/invoiceExport.js";
import { lateStockArrival } from "../src/services/stockArrival.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

// Client revisions of 2026-11-13 (synthetic data only).

test("the LN text is the recorded lots, else the Batch ID", () => {
  assert.equal(invoiceLotText({ batchId: "B1", lotNumber: "LOT-A12 (6), B3 (4)" }), "LOT-A12 (6), B3 (4)");
  assert.equal(invoiceLotText({ batchId: "B1" }), "B1", "older invoices and manual lines");
  assert.equal(invoiceLotText({}), "");
});

test("a server-priced invoice waits for Save draft before it can name its lots", () => {
  const order = { pricingVersion: 1, items: [{ reservedQuantity: 4 }] };
  assert.equal(invoiceLotsNeedSave({ order, invoice: null }), true, "no draft yet");
  assert.equal(invoiceLotsNeedSave({ order, invoice: { invoiceStatus: "draft", items: [{ batchId: "B1" }] } }), true, "draft saved before lots existed");
  assert.equal(invoiceLotsNeedSave({ order, invoice: { invoiceStatus: "draft", items: [{ allocatedLots: [{ quantity: 4 }] }] } }), false);
  assert.equal(invoiceLotsNeedSave({ order, invoice: { invoiceStatus: "issued", items: [] } }), false, "issued invoices are left as issued");
  assert.equal(invoiceLotsNeedSave({ order: { pricingVersion: 1, items: [{ reservedQuantity: 0 }] }, invoice: null }), false, "nothing reserved yet");
  assert.equal(invoiceLotsNeedSave({ order: { items: [{ reservedQuantity: 4 }] }, invoice: null }), false, "manual (legacy) orders");
});

test("the Excel LN cell prints the lots in the same cell as before", () => {
  const item = (extra) => ({ itemDescription: "Vaccine", quantity: 10, unitPrice: 100, expiry: "2027-03-01", batchId: "B1", ...extra });
  const totals = { subtotal: 1000, grandTotal: 1000 };
  const cellE = (it) => {
    const rows = buildInvoiceWorksheet({ form: { items: [it], invoiceDate: "2026-11-13" }, totals, invoiceNumber: "INV-1" });
    const row = rows.find((r) => r[4]?.value?.startsWith?.("LN"));
    return row[4].value;
  };
  assert.equal(cellE(item({ lotNumber: "LOT-A12 (6), B3 (4)" })), "LN: LOT-A12 (6), B3 (4)");
  assert.equal(cellE(item({})), "LN: B1");
});

test("the invoice editor labels LN and locks server-recorded lots", () => {
  const editor = read("src/pages/admin/InvoiceEditor.jsx");
  assert.match(editor, /<span className="sit-bn">LN:<\/span>/);
  assert.match(editor, /value=\{serverPriced && lotsNeedSave \? "" : invoiceLotText\(it\)\}/);
  assert.match(editor, /if \(lotsNeedSave\) \{\s*setMessage\(\{ type: "error", text: LOTS_NEED_SAVE_MESSAGE \}\);/);
});

test("checkout warns when cart stock arrives after the requested date", () => {
  const items = [{ inventoryId: "b1", name: "Vaccine A" }, { inventoryId: "b2", name: "Vaccine B" }];
  const batches = [{ id: "b1", arrivalDate: "2026-11-25" }, { id: "b2", arrivalDate: "2026-11-10" }];
  const late = lateStockArrival(items, batches, "2026-11-15");
  assert.equal(late.latestArrival, "2026-11-25");
  assert.deepEqual(late.names, ["Vaccine A"]);
  assert.match(late.text, /after your requested date/);
  assert.equal(lateStockArrival(items, batches, "2026-11-25"), null);
  assert.equal(lateStockArrival(items, null, "2026-11-15"), null, "still loading");
  assert.equal(lateStockArrival(items, [{ id: "b1" }], "2026-11-15"), null, "no arrival date recorded");
});

test("Add Stock and Batch details carry Supplier and Lot Number", () => {
  const add = read("src/pages/admin/AddStock.jsx");
  assert.match(add, /id="stock-supplier"/);
  assert.match(add, /id="stock-lot-number"/);
  assert.match(add, /supplier: supplier\.trim\(\),\s*lotNumber: lotNumber\.trim\(\),/);
  const inv = read("src/pages/admin/Inventory.jsx");
  assert.match(inv, /id="inv-batch-supplier" value=\{batchDraft\?\.supplier \?\? ""\} placeholder="Not recorded"/);
  assert.match(inv, /id="inv-batch-lot" value=\{batchDraft\?\.lotNumber \?\? ""\} placeholder="Not recorded"/);
  assert.match(read("src/services/inventoryCallables.js"), /\.\.\.\(supplier \? \{ supplier \} : \{\}\),\s*\.\.\.\(lotNumber \? \{ lotNumber \} : \{\}\),/);
});

test("an open zero-rating request for other details is explained, never silently dropped", async () => {
  const { zeroRateRequestNoLongerMatching } = await import("../src/services/zeroRateOrderMatch.js");
  const row = {
    id: "z1", status: "approved", doctorId: "d1", doctorAddressId: "home", requestedDeliveryDate: "2026-11-18",
    items: [{ inventoryId: "b1", quantity: 1 }, { inventoryId: "b2", quantity: 3 }], createdAt: { toMillis: () => 5 },
  };
  const cart = { doctorId: "d1", doctorAddressId: "home", requestedDeliveryDate: "2026-11-18", today: "2026-11-13",
    items: [{ inventoryId: "b1", quantity: 1 }, { inventoryId: "b2", quantity: 3 }] };
  assert.equal(zeroRateRequestNoLongerMatching([row], cart), null, "an exact match needs no note");
  const counts = zeroRateRequestNoLongerMatching([row], { ...cart, items: [{ inventoryId: "b1", quantity: 1 }, { inventoryId: "b2", quantity: 4 }] });
  assert.deepEqual(counts.changes, ["vial counts"]);
  assert.match(counts.text, /approved\) no longer matches this cart: the vial counts changed\. Nothing in your cart was removed\./);
  assert.deepEqual(zeroRateRequestNoLongerMatching([row], { ...cart, requestedDeliveryDate: "2026-11-19", items: [{ inventoryId: "b1", quantity: 1 }] }).changes, ["delivery date", "items"]);
  assert.match(zeroRateRequestNoLongerMatching([{ ...row, status: "pending" }], { ...cart, doctorAddressId: "c1" }).text, /waiting for Admin\) .*the delivery address changed/);
  for (const status of ["rejected", "used"]) assert.equal(zeroRateRequestNoLongerMatching([{ ...row, status }], { ...cart, items: [] }), null, status);
  assert.equal(zeroRateRequestNoLongerMatching([{ ...row, requestedDeliveryDate: "2026-11-01" }], { ...cart, items: [] }), null, "past deliveries are not raised");
});

test("a denial is shown after a refresh too, until the Med Rep chooses standard VAT", async () => {
  const { zeroRateStep, ZERO_RATE_STEP: Z } = await import("../src/services/zeroRateStep.js");
  const base = { hasVatable: true, approved: false, pending: false, denied: true, answer: "" };
  assert.equal(zeroRateStep(base), Z.DENIED, "blank answer after a refresh");
  assert.equal(zeroRateStep({ ...base, answer: "no" }), Z.STANDARD);
  assert.equal(zeroRateStep({ ...base, answer: "yes" }), Z.DENIED);
  const page = read("src/pages/salesRep/SalesRepPlaceOrder.jsx");
  assert.match(page, /<p className="zero-rate-checkout-stale" role="status">\{staleZeroRate\.text\}<\/p>/);
});

test("the Dispatcher calendar looks each order's Med Rep name up once per visit", () => {
  const cal = read("src/components/schedule/DeliveryCalendar.jsx");
  assert.match(cal, /\]\.join\("\|"\),\s*\[dayOrders, currentDayPage, unscheduled, currentUnscheduledPage\]\);/, "keyed by the visible ids, not array identity");
  assert.match(cal, /const missing = visibleLookupKey\.split\("\|"\)\.filter\(\(id\) => !nameCache\.has\(id\)\);/);
  assert.match(cal, /fetchOrderMedRepNames\(missing\)/);
});
