import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  AWAITING_BATCH_LABEL,
  INITIAL_ALLOCATION_PENDING,
  LEGACY_RECEIPT_MESSAGE,
  LOADED_FILTER_NOTICE,
  RECEIPT_DISCLAIMER,
  confirmationSnapshot,
  currentLineFulfilment,
  eventBatches,
  fulfilmentStage,
  historyRow,
  loadedFilterNotice,
  matchesHistoryFilters,
  mergeHistoryPage,
  receiptLines,
  receiptStatus,
  sortEvents,
} from "../src/services/orderHistory.js";

// Order Receipt History + Stock Allocation History (web).
//
// Behaviour of the pure helpers both history pages render from, plus
// source-shape checks for the parts a node test cannot render (this repo has
// no jsdom/RTL; adding one would be a dependency change).

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", ...p), "utf8");

const ts = (iso) => ({ toMillis: () => Date.parse(iso) });

// The staging scenario: Allocation Test Vaccine quoted from BT-3131-3131.
const quotedLine = (over = {}) => ({
  inventoryId: "bt3131", batchId: "BT-3131-3131", name: "Allocation Test Vaccine", sku: "ATV-001",
  productKey: "vacP", quantity: 1, reservedQuantity: 0, backorderedQuantity: 1, ...over,
});
const v2 = (over = {}) => ({
  id: "ordB", orderNumber: "VT-ORD-1785000000000-ABCD", status: "pending_dispatch", allocationVersion: 2,
  allocationState: "awaiting_stock", priority: "Urgent", createdAt: ts("2026-10-05T02:00:00Z"),
  doctorName: "Dr. Ana Reyes", clinicName: "Dr. Ana Reyes — Clinic", createdByUid: "rep1",
  items: [quotedLine()], ...over,
});
const allocEvent = (over = {}) => ({
  id: "ordA__e0__alloc__vacP__r1", eventType: "stock_allocated", epoch: 0, ordinal: 0,
  createdAt: ts("2026-10-05T02:00:01Z"),
  lines: [{ lineIndex: 0, batches: [{ inventoryId: "bt3131", batchId: "BT-3131-3131", quantity: 1 }] }],
  batches: [{ inventoryId: "bt3131", batchId: "BT-3131-3131", quantity: 1, lineIndex: 0 }],
  ...over,
});

// ---------------------------------------------------------------- 19

test("19. a fully backordered line shows “Awaiting batch allocation”, never its quoted batch", () => {
  const order = v2(); // quoted from BT-3131-3131, nothing reserved
  const [line] = currentLineFulfilment(order, []);
  assert.equal(line.reserved, 0);
  assert.deepEqual(line.batches, []);
  assert.equal(line.batchNote, AWAITING_BATCH_LABEL);
  assert.equal(AWAITING_BATCH_LABEL, "Awaiting batch allocation");
  // Even a stray event naming a batch cannot put one on a line with nothing reserved.
  const [stillNone] = currentLineFulfilment(order, [allocEvent()]);
  assert.deepEqual(stillNone.batches, []);
});

test("batches appear only where an allocation event proves them", () => {
  const partial = v2({ id: "ordA", priority: "Standard", allocationState: "partially_reserved",
    items: [quotedLine({ quantity: 3, reservedQuantity: 1, backorderedQuantity: 2 })] });
  const [line] = currentLineFulfilment(partial, [allocEvent()]);
  assert.deepEqual(line.batches.map((b) => [b.batchId, b.quantity]), [["BT-3131-3131", 1]]);
  assert.equal(line.batchNote, null);

  // Reserved, but placed before the ledger existed: say so — never use the quote.
  const [legacy] = currentLineFulfilment(partial, []);
  assert.deepEqual(legacy.batches, []);
  assert.match(legacy.batchNote, /not recorded/);
  assert.ok(!JSON.stringify(legacy).includes("BT-3131-3131"));
});

test("released and returned units leave the line; a requeue starts a new epoch", () => {
  const order = v2({ id: "ordF", failureCount: 1, allocationState: "partially_reserved",
    items: [quotedLine({ quantity: 2, reservedQuantity: 1, backorderedQuantity: 1 })] });
  const events = [
    allocEvent({ id: "a0", lines: [{ lineIndex: 0, batches: [{ inventoryId: "old", batchId: "OLD", quantity: 2 }] }] }),
    allocEvent({ id: "r0", eventType: "moved_to_return_pending", createdAt: ts("2026-10-05T03:00:00Z"),
      lines: [{ lineIndex: 0, batches: [{ inventoryId: "old", batchId: "OLD", quantity: 2 }] }] }),
    allocEvent({ id: "a1", epoch: 1, createdAt: ts("2026-10-05T04:00:00Z"),
      lines: [{ lineIndex: 0, batches: [{ inventoryId: "new", batchId: "NEW", quantity: 1 }] }] }),
  ];
  const [line] = currentLineFulfilment(order, events);
  assert.deepEqual(line.batches.map((b) => b.batchId), ["NEW"], "only the current epoch's reservation");
});

test("consumed lines are marked delivered", () => {
  const order = v2({ status: "delivered", allocationState: "fully_reserved",
    items: [quotedLine({ reservedQuantity: 1, backorderedQuantity: 0 })] });
  const events = [allocEvent(), allocEvent({ id: "c", eventType: "reservation_consumed", createdAt: ts("2026-10-06T00:00:00Z"),
    lines: [{ lineIndex: 0, consumedQuantity: 1, batches: [] }] })];
  const [line] = currentLineFulfilment(order, events);
  assert.equal(line.delivered, true);
  assert.deepEqual(line.batches.map((b) => b.batchId), ["BT-3131-3131"]);
});

// ---------------------------------------------------------------- 20

test("20. an order without a receipt is legacy — the warning, never a fabricated receipt", () => {
  assert.equal(LEGACY_RECEIPT_MESSAGE, "Legacy order — original receipt snapshot unavailable");
  assert.equal(receiptStatus(null), "legacy");
  assert.equal(receiptStatus(undefined), "legacy");
  assert.equal(receiptStatus({ receiptKind: "original", isReconstructed: false }), "original");
  assert.equal(receiptStatus({ receiptKind: "reconstructed", isReconstructed: true }), "reconstructed");
  const row = historyRow(v2(), null);
  assert.equal(row.receiptStatus, "legacy");
  assert.equal(row.receipt, null);

  // The detail view renders the notice in place of the receipt and never
  // builds a receipt from the order.
  const detail = read("src", "components", "history", "OrderHistoryDetail.jsx");
  assert.match(detail, /\{row\.receipt \? <Receipt receipt=\{row\.receipt\} events=\{events\}[^/]*\/> : <LegacyNotice \/>\}/);
  assert.match(detail, /<strong>\{LEGACY_RECEIPT_MESSAGE\}<\/strong>/);
  assert.doesNotMatch(detail, /<Receipt receipt=\{(order|row\.order)/, "the receipt is never built from the order");
  // Current data is shown in its own, separately titled section.
  assert.match(detail, /2\. Current Fulfillment Summary/);
  assert.match(detail, /1\. Original \{RECEIPT_TITLE\}/);
});

test("the receipt is presented as a confirmation, not an invoice or proof of payment", () => {
  assert.match(RECEIPT_DISCLAIMER, /not an official invoice and not proof of payment/);
  const detail = read("src", "components", "history", "OrderHistoryDetail.jsx");
  assert.match(detail, /\{RECEIPT_DISCLAIMER\}/);
  assert.doesNotMatch(detail, /Official Receipt|Proof of payment|Sales Invoice/i);
});

test("receipt lines carry the reservation at confirmation when it was recorded", () => {
  const receipt = { lines: [{ lineIndex: 0, quantityRequested: 3, unitPriceCentavos: 125000 }] };
  const snapshot = confirmationSnapshot([{ eventType: "initial_allocation", reservedQuantityAfter: 1, backorderedQuantityAfter: 2,
    lines: [{ lineIndex: 0, reservedQuantityAfter: 1, backorderedQuantityAfter: 2 }] }]);
  assert.deepEqual(receiptLines(receipt, snapshot).map((l) => [l.reservedAtConfirmation, l.backorderedAtConfirmation]), [[1, 2]]);
  assert.deepEqual(receiptLines(receipt, null).map((l) => l.reservedAtConfirmation), [null], "not recorded → shown as such");
});

// ---------------------------------------------------------------- list

test("every order status maps to one history stage", () => {
  const stage = (over) => fulfilmentStage(v2(over)).value;
  assert.equal(stage({ allocationState: "awaiting_stock" }), "awaiting_stock");
  assert.equal(stage({ allocationState: "partially_reserved" }), "partially_reserved");
  assert.equal(stage({ allocationState: "fully_reserved" }), "fully_reserved");
  assert.equal(fulfilmentStage({ status: "pending_dispatch" }).value, "processing", "untracked orders are processing");
  for (const s of ["assigned", "loading", "in_transit", "delayed", "delivered", "cancelled"]) assert.equal(stage({ status: s }), s);
  assert.equal(stage({ status: "delivery_failed" }), "failed");
  assert.equal(stage({ status: "completed" }), "delivered");
  assert.equal(stage({ status: "canceled" }), "cancelled");
});

test("search and filters: full reference, doctor, clinic, SKU, status, allocation, priority, dates", () => {
  const row = historyRow(v2(), { medRepName: "Rep One", skus: ["ATV-001"] });
  assert.equal(row.reference, "VT-ORD-1785000000000-ABCD", "the full reference, untruncated");
  for (const q of ["VT-ORD-1785000000000-ABCD", "abcd", "ana reyes", "clinic", "atv-001", "rep one"]) {
    assert.ok(matchesHistoryFilters(row, { search: q }), q);
  }
  assert.ok(!matchesHistoryFilters(row, { search: "nope" }));
  assert.ok(matchesHistoryFilters(row, { stage: "awaiting_stock", allocationState: "awaiting_stock", priority: "Urgent" }));
  assert.ok(!matchesHistoryFilters(row, { stage: "delivered" }));
  assert.ok(!matchesHistoryFilters(row, { priority: "Standard" }));
  // 2026-10-05T02:00Z is 10:00 on 5 October in Manila.
  assert.ok(matchesHistoryFilters(row, { dateFrom: "2026-10-05", dateTo: "2026-10-05" }));
  assert.ok(!matchesHistoryFilters(row, { dateFrom: "2026-10-06" }));
  assert.ok(!matchesHistoryFilters(row, { dateTo: "2026-10-04" }));
});

test("the timeline is chronological, then by write order within one commit", () => {
  const t = ts("2026-10-05T02:00:01Z");
  const out = sortEvents([
    { id: "state", createdAt: t, ordinal: 1 },
    { id: "alloc", createdAt: t, ordinal: 0 },
    { id: "placed", createdAt: ts("2026-10-05T02:00:00Z"), ordinal: 0 },
  ]);
  assert.deepEqual(out.map((e) => e.id), ["placed", "alloc", "state"]);
  assert.deepEqual(eventBatches({ batches: [{ batchId: "B", quantity: 2 }, { batchId: "Z", quantity: 0 }] }), [{ label: "B", quantity: 2 }]);
});

// ---------------------------------------------------------------- wiring

test("history is read-only on the client and scoped to the Med Rep", () => {
  const service = read("src", "services", "orderHistoryService.js");
  for (const write of ["setDoc", "addDoc", "updateDoc", "deleteDoc", "writeBatch", "runTransaction", "httpsCallable"]) {
    assert.ok(!service.includes(write), `orderHistoryService must not ${write}`);
  }
  for (const f of ["OrderHistoryView.jsx", "OrderHistoryDetail.jsx"]) {
    const src = read("src", "components", "history", f);
    assert.doesNotMatch(src, /from "firebase\/firestore"/, `${f} goes through the service`);
  }
  // Med Rep queries filter on their own uid (the rules require it).
  assert.match(service, /if \(medRepUid\) parts\.push\(where\("createdByUid", "==", medRepUid\)\)/);
  assert.match(service, /if \(medRepUid\) parts\.unshift\(where\("medRepUid", "==", medRepUid\)\)/);
  assert.match(service, /if \(medRepUid\) parts\.push\(where\("medRepUid", "==", medRepUid\)\)/);
  const view = read("src", "components", "history", "OrderHistoryView.jsx");
  assert.match(view, /const scopeUid = isAdmin \? null : medRepUid;/);
  // Bounded, incremental loading.
  assert.match(service, /limit\(pageSize\)/);
  assert.match(view, /Load \$\{HISTORY_PAGE_SIZE\} older orders/);
  // Loading, error, empty and permission-denied states.
  assert.match(view, /Loading order history…/);
  assert.match(view, /You do not have permission to view/);
  assert.match(view, /You have not placed any orders yet\./);
  assert.match(view, /No orders match these filters\./);
});

test("routes and navigation: Med Rep and Admin history inside their shells", () => {
  const app = read("src", "App.jsx");
  assert.match(app, /<Route path="\/sales-rep\/order-history" element=\{<SalesRepOrderHistory \/>\} \/>/);
  assert.match(app, /<Route path="\/admin\/order-history" element=\{<AdminOrderHistory \/>\} \/>/);
  assert.match(app, /lazy\(\(\) => import\("\.\/pages\/salesRep\/SalesRepOrderHistory"\)\)/);
  assert.match(app, /lazy\(\(\) => import\("\.\/pages\/admin\/AdminOrderHistory"\)\)/);
  assert.match(read("src", "pages", "salesRep", "SalesRepShell.jsx"), /to="\/sales-rep\/order-history"/);
  assert.match(read("src", "components", "admin", "AdminSidebar.jsx"), /to="\/admin\/order-history"/);
  const page = read("src", "pages", "salesRep", "SalesRepOrderHistory.jsx");
  assert.match(page, /<OrderHistoryView mode="salesrep" medRepUid=\{uid\} \/>/);
  assert.match(read("src", "pages", "admin", "AdminOrderHistory.jsx"), /<OrderHistoryView mode="admin" \/>/);
});

test("Stock Allocation stays the current queue and links to history", () => {
  const alloc = read("src", "pages", "admin", "AdminAllocation.jsx");
  assert.match(alloc, /subscribeBackorderQueue\(/, "the operational queue is unchanged");
  assert.match(alloc, /to="\/admin\/order-history"/);
  assert.match(alloc, /Backorder queue \(current\)/);
});

test("printing is scoped to the receipt and to the moment of printing", () => {
  const css = read("src", "components", "history", "OrderHistory.css");
  assert.match(css, /@media print \{\s*body\.ohx-printing \* \{/);
  assert.doesNotMatch(css, /@media print \{\s*body \* \{/, "never hides other pages' printouts");
  const detail = read("src", "components", "history", "OrderHistoryDetail.jsx");
  assert.match(detail, /document\.body\.classList\.add\(cls\)/);
  assert.match(detail, /window\.print\(\)/);
});

test("rules and indexes back the history pages", () => {
  const rules = read("firestore.rules");
  for (const col of ["orderReceipts", "inventoryAllocationEvents"]) {
    const start = rules.indexOf(`match /${col}/`);
    assert.ok(start > 0, `${col} has a rules block`);
    const block = rules.slice(start, rules.indexOf("\n    }", start));
    assert.match(block, /allow write: if false;/, `${col} is server-only`);
    assert.match(block, /isSalesRep\(\) && resource\.data\.medRepUid == request\.auth\.uid/);
    assert.doesNotMatch(block, /isDispatcher|isRider/, `${col}: no Dispatcher/Rider access`);
  }
  const idx = JSON.parse(read("firestore.indexes.json")).indexes.map(
    (i) => `${i.collectionGroup}:${i.fields.map((f) => `${f.fieldPath}${f.order ? `/${f.order[0]}` : "/C"}`).join(",")}`
  );
  for (const want of [
    "orders:createdByUid/A,createdAt/D",
    "inventoryAllocationEvents:orderId/A,createdAt/A",
    "inventoryAllocationEvents:medRepUid/A,orderId/A,createdAt/A",
    "inventoryAllocationEvents:batchIds/C,createdAt/D",
    "orderReceipts:skus/C,createdAt/D",
  ]) assert.ok(idx.includes(want), want);
});

// ---------------------------------------------------------------- durability review

test("paging: loading older orders never duplicates, and stays stable when new orders arrive", () => {
  const r = (id) => ({ id });
  const page1 = [r("o9"), r("o8"), r("o7")];
  // A new order is placed while browsing: it sorts BEFORE page 1, so the
  // cursor-based page 2 continues after o7. A defensive overlap is dropped.
  const page2 = [r("o7"), r("o6"), r("o5")];
  assert.deepEqual(mergeHistoryPage(page1, page2).map((x) => x.id), ["o9", "o8", "o7", "o6", "o5"]);
  assert.deepEqual(mergeHistoryPage([], [r("a"), r("a")]).map((x) => x.id), ["a"], "duplicates within a page too");

  const service = read("src", "services", "orderHistoryService.js");
  // Document cursor (createdAt ↓ + id tie-break), never an offset.
  assert.match(service, /orderBy\("createdAt", "desc"\)/);
  assert.match(service, /if \(cursor\) parts\.push\(startAfter\(cursor\)\)/);
  assert.doesNotMatch(service, /offset\(/);
  const view = read("src", "components", "history", "OrderHistoryView.jsx");
  assert.match(view, /setRows\(\(prev\) => mergeHistoryPage\(prev, next\)\)/);
  assert.match(view, /if \(seq !== requestSeq\.current\) return;\s*setRows\(\(prev\) => mergeHistoryPage/, "a page for an old scope is dropped");
});

test("the loaded-records limitation is stated whenever a filter applies to loaded records", () => {
  assert.equal(LOADED_FILTER_NOTICE, "Search/filtering currently covers loaded records");
  assert.equal(loadedFilterNotice({ filtersActive: false, hasMore: true, loadedCount: 25 }), null);
  assert.match(loadedFilterNotice({ filtersActive: true, hasMore: true, loadedCount: 25 }), /^Search\/filtering currently covers loaded records \(25 loaded\)/);
  assert.match(loadedFilterNotice({ filtersActive: true, hasMore: false, loadedCount: 7 }), /^Search\/filtering currently covers loaded records — all 7/);
  const view = read("src", "components", "history", "OrderHistoryView.jsx");
  assert.match(view, /const clientFiltered = Boolean\(filters\.search \|\| filters\.stage \|\| filters\.allocationState \|\| filters\.priority\);/);
  assert.match(view, /loadedFilterNotice\(\{ filtersActive: clientFiltered, hasMore, loadedCount: rows\.length \}\)/);
  assert.match(view, /\{loadedNotice && <p className="ohx-loaded-notice" role="note">\{loadedNotice\}<\/p>\}/);
});

test("exact reference lookup queries the whole authorized history, not the loaded page", () => {
  const service = read("src", "services", "orderHistoryService.js");
  const fn = service.slice(service.indexOf("export async function findOrdersByReference"), service.indexOf("export async function findOrderIdsBySku"));
  assert.match(fn, /query\(collection\(db, ORDERS\), \.\.\.parts, limit\(10\)\)/, "a Firestore query, not a filter of loaded rows");
  assert.match(fn, /where\("orderNumber", "==", value\)/);
  assert.match(fn, /if \(medRepUid\) parts\.unshift\(where\("createdByUid", "==", medRepUid\)\)/, "a Med Rep's lookup keeps the ownership restriction");
  const view = read("src", "components", "history", "OrderHistoryView.jsx");
  assert.match(view, /if \(lookup\.kind === "reference"\) orders = await findOrdersByReference\(value, scopeUid\);/);
});

test("every query is bounded; Med Rep queries always carry the ownership restriction", () => {
  const service = read("src", "services", "orderHistoryService.js");
  const queries = service.match(/query\(collection\(db, [A-Z"a-z]+\)[^;]*\)/g) || [];
  assert.ok(queries.length >= 7);
  for (const q of queries) {
    const bounded = /limit\(/.test(q) || /\.\.\.parts\)/.test(q) || /where\(documentId\(\), "in", part\)/.test(q) || /where\("orderId", "in"/.test(q) || /\.\.\.parts\)\)/.test(q);
    assert.ok(bounded, `unbounded query: ${q}`);
  }
  // The ...parts queries: each builder pushes a limit, or is an `in` of ≤30 ids.
  assert.match(service, /parts\.push\(limit\(pageSize\)\)/);
  assert.match(service, /parts\.push\(where\("orderId", "==", orderId\), orderBy\("createdAt", "asc"\), limit\(500\)\)/);
  assert.match(service, /const IN_LIMIT = 30;/);
  assert.match(service, /limit\(MED_REP_LIMIT\)/);
  // A Med Rep view passes its uid to every query helper.
  const view = read("src", "components", "history", "OrderHistoryView.jsx");
  assert.match(view, /medRepUid: isAdmin \? repFilter \|\| null : scopeUid/);
  assert.match(view, /fetchReceiptsForOrders\(orders\.map\(\(o\) => o\.id\), scopeUid\)/);
  const detail = read("src", "components", "history", "OrderHistoryDetail.jsx");
  assert.match(detail, /mode === "admin" \? null : medRepUid/);
});

test("an original receipt whose initial record is still being written shows it as pending, never “not recorded”", () => {
  assert.equal(confirmationSnapshot([]), null);
  assert.equal(confirmationSnapshot([{ eventType: "initial_allocation", recovered: true, lines: [] }]).recovered, true);
  const detail = read("src", "components", "history", "OrderHistoryDetail.jsx");
  assert.match(detail, /INITIAL_ALLOCATION_PENDING/);
  assert.doesNotMatch(detail, /Not recorded/);
  assert.match(INITIAL_ALLOCATION_PENDING, /^Recording the reservation at confirmation/);
});
