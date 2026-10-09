"use strict";

/**
 * Order Confirmation Receipts and the Stock Allocation History ledger.
 *
 *   orderReceipts/{orderId}
 *     The order EXACTLY as the server accepted it. Created by
 *     createOrderWithReservation in the SAME transaction as the order, so an
 *     order never exists without its receipt, and never written again: later
 *     allocation, status changes, catalog or batch price changes, delivery,
 *     cancellation and failure all leave it untouched. Not an invoice and not
 *     proof of payment.
 *
 *   inventoryAllocationEvents/{eventId}
 *     Append-only. One document per meaningful stock event of one order — the
 *     order placed, units reserved, partially / fully reserved, the reservation
 *     at confirmation, released by a cancellation, consumed by a delivery,
 *     moved to Return Pending by a failure, a return's disposition, a requeue.
 *
 * TRUST. Both collections are written only here, through the Admin SDK, inside
 * the transaction that performs the stock change the event describes — never a
 * client (firestore.rules: `allow write: if false`). An event therefore exists
 * if and only if its stock change committed.
 *
 * IDEMPOTENCY. Event ids are DETERMINISTIC, derived from the state change
 * itself, never random:
 *
 *   {orderId}__placed                          once per order
 *   {orderId}__confirmed                       once per order
 *   {orderId}__e{epoch}__alloc__{product}__r{n} n = the product's reserved
 *                                              total after the allocation; it
 *                                              only grows within an epoch
 *   {orderId}__e{epoch}__state__{state}        partially / fully reserved
 *   {orderId}__cancel                          cancellation is terminal
 *   {orderId}__consume                         delivery is terminal
 *   {returnId}__return_pending                 returnId = {orderId}_{failureSeq}
 *   {returnId}__disposition                    one disposition per return
 *   {orderId}__e{epoch}__requeue               one requeue per failure
 *
 * `epoch` is the order's failureCount: it advances exactly once per failed
 * delivery, which is the only thing that resets a line's reservation. Combined
 * with the state guards each operation already has (an already-cancelled order
 * replays without writing, an allocation with nothing to do writes nothing),
 * a retried callable, a redelivered trigger or a re-run allocation writes
 * nothing new.
 *
 * APPEND-ONLY. Ids alone are not trusted: every write reads its target first
 * and is create-only (prepareEvents / createPreparedEvents below). An existing
 * identical document is an idempotent no-op; an existing DIFFERENT one is an
 * integrity conflict that aborts the transaction — nothing is ever overwritten.
 *
 * Nothing here is reconstructed. Orders placed before this existed have no
 * receipt and no events; the UI says so instead of inventing them.
 */

const { computeInvoiceTotalsCentavos, VAT_STANDARD_RATE, ITEMIZED_VAT } = require("./invoicePricing");
const { PolicyError } = require("./policy");

const RECEIPTS = "orderReceipts";
const ALLOCATION_EVENTS = "inventoryAllocationEvents";
const RECEIPT_SCHEMA_VERSION = 1;
const EVENT_SCHEMA_VERSION = 1;

const EVENT_TYPES = Object.freeze({
  ORDER_PLACED: "order_placed",
  INITIAL_ALLOCATION: "initial_allocation",
  STOCK_ALLOCATED: "stock_allocated",
  PARTIALLY_RESERVED: "partially_reserved",
  FULLY_RESERVED: "fully_reserved",
  RESERVATION_RELEASED: "reservation_released",
  BACKORDER_CANCELLED: "backorder_cancelled",
  RESERVATION_CONSUMED: "reservation_consumed",
  MOVED_TO_RETURN_PENDING: "moved_to_return_pending",
  RETURN_RESTORED: "return_restored",
  RETURN_QUARANTINED: "return_quarantined",
  RETURN_WRITTEN_OFF: "return_written_off",
  ORDER_REQUEUED: "order_requeued",
});

const SYSTEM_ACTOR = Object.freeze({ actorUid: null, actorRole: "system" });

// ---------------------------------------------------------------- small helpers

const count = (v) => (Number.isInteger(v) && v > 0 ? v : 0);
const textOrNull = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const plural = (n) => `${n.toLocaleString("en-US")} vial${n === 1 ? "" : "s"}`;

/** The reservation epoch: advances exactly once per failed delivery. */
function epochOf(order) {
  return Number.isInteger(order?.failureCount) && order.failureCount > 0 ? order.failureCount : 0;
}

/** A document id from parts. Every part is a server-side id; '/' never appears. */
function eventIdOf(...parts) {
  const id = parts.map((p) => String(p)).join("__");
  if (id.includes("/") || id.length > 1400) throw new Error(`unsafe allocation event id: ${id.slice(0, 80)}`);
  return id;
}

function actorOf(uid, role) {
  return { actorUid: typeof uid === "string" && uid ? uid : null, actorRole: role || "system" };
}

/** The line as it stands after an event. Requested never changes. */
function lineSnapshot(line, lineIndex) {
  const requested = count(line?.quantity);
  const reserved = Math.min(count(line?.reservedQuantity), requested);
  return {
    lineIndex,
    productKey: textOrNull(line?.productKey),
    sku: textOrNull(line?.sku),
    name: textOrNull(line?.name) ?? textOrNull(line?.vaccineName),
    requestedQuantity: requested,
    reservedQuantityAfter: reserved,
    backorderedQuantityAfter: Number.isInteger(line?.backorderedQuantity) && line.backorderedQuantity >= 0
      ? line.backorderedQuantity
      : Math.max(0, requested - reserved),
  };
}

function totalsOf(lines) {
  return {
    requestedQuantity: lines.reduce((s, l) => s + l.requestedQuantity, 0),
    reservedQuantityAfter: lines.reduce((s, l) => s + l.reservedQuantityAfter, 0),
    backorderedQuantityAfter: lines.reduce((s, l) => s + l.backorderedQuantityAfter, 0),
  };
}

/**
 * Assemble one event document. Fields that only make sense for a single line
 * or batch (lineIndex, productKey, sku, itemName, inventoryId, batchId) are
 * filled when the event concerns exactly one; the arrays always carry all of
 * them, and `batchIds` / `productKeys` make the ledger searchable.
 */
function buildEvent({
  orderId,
  order,
  eventType,
  sourceOperation,
  actor = SYSTEM_ACTOR,
  triggeredBy = null,
  lines = [],
  batches = [],
  quantityChanged = 0,
  allocationStateAfter = null,
  epoch = epochOf(order),
  ordinal = 0,
  summary,
  extra = {},
}) {
  const productKeys = [...new Set([
    ...lines.map((l) => l.productKey),
    ...batches.map((b) => b.productKey),
  ].filter(Boolean))].sort();
  const inventoryIds = [...new Set(batches.map((b) => b.inventoryId).filter(Boolean))].sort();
  const batchIds = [...new Set(batches.map((b) => b.batchId).filter(Boolean))].sort();
  const onlyLine = lines.length === 1 ? lines[0] : null;
  const onlyBatch = batches.length === 1 ? batches[0] : null;
  const totals = totalsOf(
    (Array.isArray(order?.items) ? order.items : []).map((l, i) => lines.find((x) => x.lineIndex === i) ?? lineSnapshot(l, i))
  );
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventType,
    orderId,
    orderNumber: textOrNull(order?.orderNumber),
    // Copied from the order's server-written owner. firestore.rules keeps
    // `createdByUid` immutable after creation, so this cannot be redirected.
    medRepUid: textOrNull(order?.createdByUid),
    reservationId: orderId,
    epoch,
    ordinal,
    lineIndex: onlyLine ? onlyLine.lineIndex : null,
    productKey: onlyLine?.productKey ?? (productKeys.length === 1 ? productKeys[0] : null),
    sku: onlyLine?.sku ?? null,
    itemName: onlyLine?.name ?? null,
    inventoryId: onlyBatch?.inventoryId ?? null,
    batchId: onlyBatch?.batchId ?? null,
    productKeys,
    inventoryIds,
    batchIds,
    lines,
    batches,
    quantityChanged,
    ...totals,
    allocationStateAfter,
    sourceOperation,
    actorUid: actor.actorUid ?? null,
    actorRole: actor.actorRole ?? "system",
    triggeredByUid: triggeredBy?.uid ?? null,
    triggeredByRole: triggeredBy?.role ?? null,
    summary,
    ...extra,
  };
}

// ---------------------------------------------------------------- append-only writes
//
// A history document is NEVER overwritten — not by a retry, a concurrent
// trigger, or an accidental id reuse, and not even by the Admin SDK. Every
// write goes through two phases inside the caller's transaction:
//
//   1. prepare (READ phase, before the transaction writes anything): read each
//      target id. Absent → it will be created. Present → its immutable content
//      is compared with what would be written: identical means this exact
//      event is already recorded (an idempotent retry) and nothing is written;
//      different is an INTEGRITY CONFLICT — logged and thrown, which aborts the
//      whole transaction, so the stock change it describes does not commit
//      either and the original document is left exactly as it was.
//   2. create (WRITE phase): tx.create() only. A create can never replace a
//      document; if one appeared after the read, the transaction fails rather
//      than overwrite it.

/** The fields that define an event. Timestamps and wording are not identity. */
const IMMUTABLE_EVENT_FIELDS = Object.freeze([
  "schemaVersion", "eventType", "orderId", "orderNumber", "medRepUid", "reservationId", "returnId",
  "epoch", "lineIndex", "productKey", "productKeys", "sku", "inventoryId", "inventoryIds", "batchId",
  "batchIds", "lines", "batches", "quantityChanged", "requestedQuantity", "reservedQuantityAfter",
  "backorderedQuantityAfter", "allocationStateAfter", "sourceOperation", "actorUid", "actorRole",
  "disposition",
]);
/** Receipt fields excluded from comparison: server timestamps only. */
const RECEIPT_VOLATILE_FIELDS = Object.freeze(["createdAt", "orderCreatedAt", "reconstructedAt"]);

/**
 * Order-independent JSON for comparison: sorted keys; an absent field, an
 * undefined one and a null one are the same (Firestore never stores undefined).
 */
function canonical(value) {
  if (value === undefined || value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    if (typeof value.toMillis === "function") return JSON.stringify({ millis: value.toMillis() });
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined && value[k] !== null).map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Field names whose canonical values differ between two documents. */
function immutableDiff(existing, proposed, fields) {
  return fields.filter((f) => canonical(existing?.[f]) !== canonical(proposed?.[f]));
}

/**
 * A history document already holds different content under this id. Logged
 * with ids and field NAMES only (no values), then thrown.
 */
function historyIntegrityError(collection, docId, fields) {
  console.error("HISTORY INTEGRITY CONFLICT — existing record left untouched", { collection, docId, fields });
  return new PolicyError(
    "history-integrity-conflict",
    "An order history record could not be written because a different record already exists. Nothing was changed; an Admin must review it.",
    { collection, docId, fields }
  );
}

/**
 * Phase 1 for events: read every target id in [tx] and verify any existing
 * document. Returns only the events still to be created. Must run before the
 * transaction's first write.
 */
async function prepareEvents(tx, { db, events }) {
  const prepared = [];
  const seen = new Map();
  for (const { eventId, event } of events) {
    if (seen.has(eventId)) {
      const diff = immutableDiff(seen.get(eventId), event, IMMUTABLE_EVENT_FIELDS);
      if (diff.length) throw historyIntegrityError(ALLOCATION_EVENTS, eventId, diff);
      continue;
    }
    seen.set(eventId, event);
    const ref = db.collection(ALLOCATION_EVENTS).doc(eventId);
    const snap = await tx.get(ref);
    if (snap.exists) {
      const diff = immutableDiff(snap.data(), event, IMMUTABLE_EVENT_FIELDS);
      if (diff.length) throw historyIntegrityError(ALLOCATION_EVENTS, eventId, diff);
      continue; // identical: already recorded — an idempotent retry writes nothing
    }
    prepared.push({ ref, eventId, event });
  }
  return prepared;
}

/** Phase 2 for events: create-only. */
function createPreparedEvents(tx, { FieldValue, prepared }) {
  for (const { ref, eventId, event } of prepared) {
    tx.create(ref, { ...event, eventId, idempotencyKey: eventId, createdAt: FieldValue.serverTimestamp() });
  }
}

/**
 * Phase 1 for a receipt: null when an identical receipt is already recorded,
 * an integrity error when a different one is, else the receipt to create.
 */
async function prepareReceipt(tx, { db, orderId, receipt }) {
  const ref = db.collection(RECEIPTS).doc(orderId);
  const snap = await tx.get(ref);
  if (snap.exists) {
    const existing = snap.data();
    const fields = [...new Set([...Object.keys(existing), ...Object.keys(receipt)])]
      .filter((f) => !RECEIPT_VOLATILE_FIELDS.includes(f));
    const diff = immutableDiff(existing, receipt, fields);
    if (diff.length) throw historyIntegrityError(RECEIPTS, orderId, diff);
    return null;
  }
  return { ref, receipt };
}

/** Phase 2 for a receipt: create-only. */
function createPreparedReceipt(tx, prepared) {
  if (prepared) tx.create(prepared.ref, prepared.receipt);
}

/** Slices grouped per order line, then per batch. v1 slices may lack lineIndex. */
function slicesByLine(slices, items) {
  const out = new Map();
  for (const s of Array.isArray(slices) ? slices : []) {
    if (!s || !Number.isInteger(s.quantity) || s.quantity <= 0) continue;
    let lineIndex = Number.isInteger(s.lineIndex) ? s.lineIndex : null;
    if (lineIndex === null && Array.isArray(items)) {
      const hit = items.findIndex((l) => l?.inventoryId === s.inventoryId);
      lineIndex = hit >= 0 ? hit : null;
    }
    const key = lineIndex === null ? "x" : String(lineIndex);
    if (!out.has(key)) out.set(key, { lineIndex, batches: [] });
    const entry = out.get(key);
    const hit = entry.batches.find((b) => b.inventoryId === s.inventoryId);
    if (hit) hit.quantity += s.quantity;
    else {
      entry.batches.push({
        inventoryId: s.inventoryId ?? null,
        batchId: textOrNull(s.batchId),
        productKey: textOrNull(s.productKey) ?? textOrNull(items?.[lineIndex]?.productKey),
        quantity: s.quantity,
      });
    }
  }
  return [...out.values()];
}

function batchPhrase(batches) {
  return batches
    .map((b) => `${plural(b.quantity)} from batch ${b.batchId || b.inventoryId}`)
    .join(", ");
}

// ---------------------------------------------------------------- receipt

/**
 * The Order Confirmation Receipt for a new order. Pure; the caller writes it
 * with tx.create in the order's own transaction.
 *
 * VAT at order time: every line carries its product's VAT snapshot (taken in
 * the order's own transaction), and the amount is computed with the SAME
 * per-item integer routine the invoice uses (invoicePricing ITEMIZED_VAT).
 * Prices are VAT-inclusive (pricingConfig.js): the VAT is EXTRACTED from the
 * VATable lines and the final total IS the subtotal — VAT is never added on
 * top. A line without a snapshot is never given an invented one: the receipt
 * then records that VAT is decided at invoicing. There is no order-time
 * discount: discounts exist only on the invoice.
 */
function buildOrderReceipt({
  orderId,
  orderNumber,
  requestId,
  uid,
  user,
  email,
  orderFields,
  items,
  FieldValue,
}) {
  const lines = items.map((i, lineIndex) => ({
    lineIndex,
    productKey: i.productKey,
    sku: textOrNull(i.sku),
    name: textOrNull(i.name),
    vaccineType: textOrNull(i.chain),
    quantityRequested: i.quantity,
    unit: "vials",
    unitPriceCentavos: i.unitPriceCentavos,
    lineTotalCentavos: i.lineTotalCentavos,
    vatClassification: i.vatClassification ?? null,
    // The batch whose price was quoted. Audit only: it is NOT a reservation,
    // and the receipt view never presents it as one.
    quotedInventoryId: i.inventoryId,
    quotedBatchId: textOrNull(i.batchId),
  }));
  const subtotalCentavos = orderFields.subtotalCentavos;
  let vatStatus = "not_classified";
  let vatRatePercent = null;
  let vatAmountCentavos = null;
  let finalTotalCentavos = null;
  const classes = new Set(lines.map((l) => l.vatClassification));
  if (lines.length > 0 && !classes.has(null)) {
    const totals = computeInvoiceTotalsCentavos({
      subtotalCentavos,
      adjustments: { discountCentavos: 0, otherChargesCentavos: 0, withholdingTaxCentavos: 0, vatClassification: ITEMIZED_VAT },
      items: lines,
    });
    vatStatus = classes.size > 1 ? "mixed" : [...classes][0];
    vatRatePercent = classes.has("vatable") ? VAT_STANDARD_RATE : 0;
    vatAmountCentavos = totals.vatAmountCentavos;
    finalTotalCentavos = totals.grandTotalCentavos;
  }
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    receiptType: "order_confirmation",
    receiptKind: "original",
    isReconstructed: false,
    orderId,
    orderNumber,
    requestId,
    medRepUid: uid,
    medRepName: textOrNull(user?.name) ?? textOrNull(user?.fullName) ?? textOrNull(user?.displayName),
    medRepEmail: textOrNull(email) ?? textOrNull(user?.email),
    doctorId: orderFields.doctorId ?? null,
    doctorName: orderFields.doctorName ?? null,
    doctorAddressId: orderFields.doctorAddressId ?? null,
    destinationType: orderFields.destinationType ?? null,
    destinationName: orderFields.destinationName ?? null,
    clinicName: orderFields.clinicName ?? null,
    deliveryAddress: orderFields.deliveryAddress ?? null,
    destinationArea: orderFields.destinationArea ?? null,
    destinationAreaId: orderFields.destinationAreaId ?? null,
    requestedDeliveryDate: orderFields.requestedDeliveryDate ?? null,
    requestedDeliveryTime: orderFields.scheduledDeliveryTime ?? null,
    priority: orderFields.priority,
    deliveryInstructions: orderFields.deliveryInstructions ?? "",
    lines,
    productKeys: [...new Set(lines.map((l) => l.productKey).filter(Boolean))].sort(),
    skus: [...new Set(lines.map((l) => l.sku).filter(Boolean))].sort(),
    totalQuantityRequested: lines.reduce((s, l) => s + l.quantityRequested, 0),
    pricingVersion: orderFields.pricingVersion,
    priceCurrency: orderFields.priceCurrency,
    priceIsVatInclusive: orderFields.priceIsVatInclusive,
    subtotalCentavos,
    vatStatus,
    vatRatePercent,
    vatAmountCentavos,
    discountCentavos: null,
    finalTotalCentavos,
    creationSource: "createOrderWithReservation",
    generatedBy: "server",
    // Same commit as the order, so the same server instant as order.createdAt.
    orderCreatedAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
  };
}

/**
 * A RECONSTRUCTED receipt for an order placed before receipts existed, built
 * from the order's server-written fields only (backfill tool, dry-run by
 * default). Everything is labelled reconstructed; fields that may have been
 * edited since placement are named. Returns null when the order carries no
 * server price snapshot — there is nothing trustworthy to rebuild from.
 */
function buildReconstructedReceipt(orderId, order) {
  if (!order || order.pricingVersion !== 1 || !Array.isArray(order.items) || order.items.length === 0) return null;
  if (typeof order.createdByUid !== "string" || !order.createdByUid) return null;
  const lines = order.items.map((i, lineIndex) => ({
    lineIndex,
    productKey: textOrNull(i.productKey),
    sku: textOrNull(i.sku),
    name: textOrNull(i.name),
    vaccineType: textOrNull(i.chain),
    quantityRequested: count(i.quantity),
    unit: "vials",
    unitPriceCentavos: Number.isInteger(i.unitPriceCentavos) ? i.unitPriceCentavos : null,
    lineTotalCentavos: Number.isInteger(i.lineTotalCentavos) ? i.lineTotalCentavos : null,
    vatClassification: i.vatClassification ?? null,
    quotedInventoryId: textOrNull(i.inventoryId),
    quotedBatchId: textOrNull(i.batchId),
  }));
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    receiptType: "order_confirmation",
    receiptKind: "reconstructed",
    isReconstructed: true,
    reconstructedFrom: "order document",
    reconstructionNotes: [
      "Built after placement from the order's server-written fields; not captured at confirmation.",
      "Priority, requested delivery date and destination show their values at reconstruction time.",
      "Initial reservation is unknown and is not shown.",
    ],
    orderId,
    orderNumber: textOrNull(order.orderNumber),
    requestId: null,
    medRepUid: order.createdByUid,
    medRepName: null,
    medRepEmail: null,
    doctorId: order.doctorId ?? null,
    doctorName: order.doctorName ?? null,
    doctorAddressId: order.doctorAddressId ?? null,
    destinationType: order.destinationType ?? null,
    destinationName: order.destinationName ?? null,
    clinicName: order.clinicName ?? null,
    deliveryAddress: order.deliveryAddress ?? order.clinicAddress ?? null,
    destinationArea: order.destinationArea ?? null,
    destinationAreaId: order.destinationAreaId ?? null,
    requestedDeliveryDate: order.requestedDeliveryDate ?? null,
    requestedDeliveryTime: order.scheduledDeliveryTime ?? null,
    priority: order.priority ?? null,
    deliveryInstructions: order.deliveryInstructions ?? "",
    lines,
    productKeys: [...new Set(lines.map((l) => l.productKey).filter(Boolean))].sort(),
    skus: [...new Set(lines.map((l) => l.sku).filter(Boolean))].sort(),
    totalQuantityRequested: lines.reduce((s, l) => s + l.quantityRequested, 0),
    pricingVersion: order.pricingVersion,
    priceCurrency: order.priceCurrency ?? "PHP",
    priceIsVatInclusive: order.priceIsVatInclusive ?? false,
    subtotalCentavos: Number.isInteger(order.subtotalCentavos) ? order.subtotalCentavos : null,
    vatStatus: "not_recorded",
    vatRatePercent: null,
    vatAmountCentavos: null,
    discountCentavos: null,
    finalTotalCentavos: null,
    creationSource: "backfillOrderReceipts",
    generatedBy: "server",
    orderCreatedAt: order.createdAt ?? null,
  };
}

// ---------------------------------------------------------------- producers

/** Order placed: every requested unit open, nothing reserved yet. Same tx as the order. */
function orderPlacedEvent({ orderId, order, actor }) {
  const lines = order.items.map(lineSnapshot);
  const requested = lines.reduce((s, l) => s + l.requestedQuantity, 0);
  return {
    eventId: eventIdOf(orderId, "placed"),
    event: buildEvent({
      orderId,
      order,
      eventType: EVENT_TYPES.ORDER_PLACED,
      sourceOperation: "createOrderWithReservation",
      actor,
      lines,
      quantityChanged: requested,
      allocationStateAfter: order.allocationState ?? "awaiting_stock",
      summary: `Order placed for ${plural(requested)}. Stock allocation pending.`,
    }),
  };
}

// ---------------------------------------------------------------- initial allocation (outbox)
//
// A new order is committed fully backordered; its FIRST allocation pass runs
// right after, in its own bounded transactions, so it competes for stock in
// priority order (allocation.js). The outcome of that pass — requested,
// initially reserved, initially backordered, state — is the order's
// "reservation at confirmation".
//
// Durability: the order's creation transaction also creates an OUTBOX marker,
// orderHistoryOutbox/{orderId} { status: "pending" }. Whoever completes the
// first pass then materializes the outcome — the placing callable on the normal
// path, or the materializeOrderHistory trigger (retry: true) if the callable
// stopped between transactions — in ONE transaction that re-reads the marker,
// creates the event and marks the marker "done". The marker serializes them:
// the second writer finds it done and writes nothing.

const OUTBOX = "orderHistoryOutbox";

/** The outbox marker, created in the order's own creation transaction. */
function initialHistoryMarker({ orderId, orderNumber, medRepUid, productKeys, FieldValue }) {
  return {
    task: "initial_allocation",
    status: "pending",
    orderId,
    orderNumber,
    medRepUid,
    productKeys: [...productKeys],
    createdAt: FieldValue.serverTimestamp(),
  };
}

/**
 * The reservation after the order's first allocation pass. [materializedBy]
 * names who recorded it; `recovered` is true when that was not the placing call
 * (the call stopped first), in which case the figures reflect the recovery's
 * own pass, which runs before recording.
 */
function initialAllocationEvent({ orderId, order, materializedBy }) {
  const lines = order.items.map(lineSnapshot);
  const t = totalsOf(lines);
  const recovered = materializedBy !== "createOrderWithReservation";
  const summary =
    t.backorderedQuantityAfter === 0
      ? `At confirmation: all ${plural(t.requestedQuantity)} reserved.`
      : t.reservedQuantityAfter === 0
        ? `At confirmation: ${plural(t.backorderedQuantityAfter)} backordered — awaiting stock.`
        : `At confirmation: ${plural(t.reservedQuantityAfter)} reserved, ${plural(t.backorderedQuantityAfter)} backordered.`;
  return {
    eventId: eventIdOf(orderId, "confirmed"),
    event: buildEvent({
      orderId,
      order,
      eventType: EVENT_TYPES.INITIAL_ALLOCATION,
      sourceOperation: materializedBy,
      actor: SYSTEM_ACTOR,
      lines,
      quantityChanged: 0,
      allocationStateAfter: order.allocationState ?? null,
      summary: recovered ? `${summary} (Recorded by the history recovery process after its own allocation pass.)` : summary,
      extra: { recovered },
    }),
  };
}

/**
 * Events for one order served by one allocation round (allocation.js). [before]
 * is the order as read in the round's transaction; [update] the planner's line
 * changes and slices for [productKey].
 */
function allocationEvents({ orderId, before, update, productKey, source, newInventoryIds = new Set() }) {
  const epoch = epochOf(before);
  const after = { ...before, items: update.items, allocationState: update.allocationState };
  const grouped = slicesByLine(update.slices, update.items);
  const lines = grouped
    .filter((g) => g.lineIndex !== null)
    .map((g) => ({ ...lineSnapshot(update.items[g.lineIndex], g.lineIndex), quantityChanged: g.batches.reduce((s, b) => s + b.quantity, 0), batches: g.batches }));
  const batches = grouped.flatMap((g) => g.batches.map((b) => ({ ...b, lineIndex: g.lineIndex })));
  const units = batches.reduce((s, b) => s + b.quantity, 0);
  const reservedForProduct = update.items
    .filter((l) => l.productKey === productKey)
    .reduce((s, l) => s + count(l.reservedQuantity), 0);
  const fromNew = batches.some((b) => newInventoryIds.has(b.inventoryId));
  const operation = source?.operation || "allocation";
  const events = [{
    eventId: eventIdOf(orderId, `e${epoch}`, "alloc", productKey, `r${reservedForProduct}`),
    event: buildEvent({
      orderId,
      order: after,
      eventType: EVENT_TYPES.STOCK_ALLOCATED,
      sourceOperation: operation,
      actor: SYSTEM_ACTOR,
      triggeredBy: source?.triggeredBy ?? null,
      lines,
      batches,
      quantityChanged: units,
      allocationStateAfter: update.allocationState,
      epoch,
      ordinal: 0,
      summary: `Reserved ${batchPhrase(batches)}${fromNew ? " (newly added stock)" : operation === "confirmReturnDisposition" ? " (returned stock confirmed usable)" : ""}.`,
      extra: { stockAddedInThisOperation: fromNew, continuationOf: source?.continuationOf ?? null },
    }),
  }];
  if (before?.allocationState !== update.allocationState &&
      (update.allocationState === "partially_reserved" || update.allocationState === "fully_reserved")) {
    const full = update.allocationState === "fully_reserved";
    const allLines = update.items.map(lineSnapshot);
    const t = totalsOf(allLines);
    events.push({
      eventId: eventIdOf(orderId, `e${epoch}`, "state", update.allocationState),
      event: buildEvent({
        orderId,
        order: after,
        eventType: full ? EVENT_TYPES.FULLY_RESERVED : EVENT_TYPES.PARTIALLY_RESERVED,
        sourceOperation: operation,
        actor: SYSTEM_ACTOR,
        triggeredBy: source?.triggeredBy ?? null,
        lines: allLines,
        quantityChanged: 0,
        allocationStateAfter: update.allocationState,
        epoch,
        ordinal: 1,
        summary: full
          ? `Fully reserved: all ${plural(t.requestedQuantity)}. The order has left the backorder queue.`
          : `Partially reserved: ${plural(t.reservedQuantityAfter)} of ${plural(t.requestedQuantity)}; ${plural(t.backorderedQuantityAfter)} still awaiting stock.`,
      }),
    });
  }
  return events;
}

/** Cancellation: reserved units released; any backordered units no longer awaited. */
function cancellationEvent({ orderId, order, reservationItems, uid }) {
  const grouped = slicesByLine(reservationItems, order.items);
  const batches = grouped.flatMap((g) => g.batches.map((b) => ({ ...b, lineIndex: g.lineIndex })));
  const released = batches.reduce((s, b) => s + b.quantity, 0);
  const items = Array.isArray(order.items) ? order.items : [];
  const lines = items.map((l, i) => {
    const before = lineSnapshot(l, i);
    const g = grouped.find((x) => x.lineIndex === i);
    return {
      ...before,
      releasedQuantity: g ? g.batches.reduce((s, b) => s + b.quantity, 0) : 0,
      backorderWithdrawnQuantity: order.allocationVersion === 2 ? before.backorderedQuantityAfter : 0,
      reservedQuantityAfter: 0,
      backorderedQuantityAfter: 0,
      batches: g ? g.batches : [],
    };
  });
  const withdrawn = lines.reduce((s, l) => s + l.backorderWithdrawnQuantity, 0);
  const parts = [];
  if (released > 0) parts.push(`released ${batchPhrase(batches)} back to available stock`);
  if (withdrawn > 0) parts.push(`${plural(withdrawn)} no longer awaited`);
  return {
    eventId: eventIdOf(orderId, "cancel"),
    event: buildEvent({
      orderId,
      order: { ...order, items: items.map((l) => ({ ...l, reservedQuantity: 0, backorderedQuantity: 0 })) },
      eventType: released > 0 ? EVENT_TYPES.RESERVATION_RELEASED : EVENT_TYPES.BACKORDER_CANCELLED,
      sourceOperation: "cancelOrderWithInventoryRelease",
      actor: actorOf(uid, "dispatcher"),
      lines,
      batches,
      quantityChanged: released,
      allocationStateAfter: null,
      summary: `Order cancelled: ${parts.join("; ") || "no stock was held"}.`,
      extra: { releasedQuantity: released, backorderWithdrawnQuantity: withdrawn },
    }),
  };
}

/** Delivery completed: the reserved units leave stock for good. */
function consumptionEvent({ orderId, order, reservationItems, uid }) {
  const grouped = slicesByLine(reservationItems, order.items);
  const batches = grouped.flatMap((g) => g.batches.map((b) => ({ ...b, lineIndex: g.lineIndex })));
  const consumed = batches.reduce((s, b) => s + b.quantity, 0);
  const items = Array.isArray(order.items) ? order.items : [];
  const lines = items.map((l, i) => {
    const g = grouped.find((x) => x.lineIndex === i);
    return {
      ...lineSnapshot(l, i),
      consumedQuantity: g ? g.batches.reduce((s, b) => s + b.quantity, 0) : 0,
      reservedQuantityAfter: 0,
      backorderedQuantityAfter: 0,
      batches: g ? g.batches : [],
    };
  });
  return {
    eventId: eventIdOf(orderId, "consume"),
    event: buildEvent({
      orderId,
      order: { ...order, items: items.map((l) => ({ ...l, reservedQuantity: 0, backorderedQuantity: 0 })) },
      eventType: EVENT_TYPES.RESERVATION_CONSUMED,
      sourceOperation: "markOrderDeliveredWithInventoryConsumption",
      actor: actorOf(uid, "rider"),
      lines,
      batches,
      quantityChanged: consumed,
      allocationStateAfter: order.allocationState ?? null,
      summary: `Delivered: ${batchPhrase(batches) || plural(consumed)} consumed from stock.`,
      extra: { consumedQuantity: consumed },
    }),
  };
}

/** Failed delivery: reserved units → Return Pending (neither reserved nor available). */
function returnPendingEvent({ orderId, order, reservationItems, returnId, reportedByUid, sourceOperation }) {
  const grouped = slicesByLine(reservationItems, order.items);
  const batches = grouped.flatMap((g) => g.batches.map((b) => ({ ...b, lineIndex: g.lineIndex })));
  const moved = batches.reduce((s, b) => s + b.quantity, 0);
  const items = Array.isArray(order.items) ? order.items : [];
  const v2 = order.allocationVersion === 2;
  const afterItems = v2 ? items.map((l) => ({ ...l, reservedQuantity: 0, backorderedQuantity: l.quantity })) : items;
  const lines = afterItems.map((l, i) => {
    const g = grouped.find((x) => x.lineIndex === i);
    return { ...lineSnapshot(l, i), returnedQuantity: g ? g.batches.reduce((s, b) => s + b.quantity, 0) : 0, batches: g ? g.batches : [] };
  });
  return {
    eventId: eventIdOf(returnId, "return_pending"),
    event: buildEvent({
      orderId,
      order: { ...order, items: afterItems },
      eventType: EVENT_TYPES.MOVED_TO_RETURN_PENDING,
      sourceOperation,
      actor: actorOf(reportedByUid, "rider"),
      lines,
      batches,
      quantityChanged: moved,
      allocationStateAfter: v2 ? "awaiting_stock" : order.allocationState ?? null,
      // The units belonged to the epoch that just failed.
      epoch: epochOf(order),
      summary: `Delivery failed: ${batchPhrase(batches)} moved to Return Pending. Not available until an Admin confirms their condition.`,
      extra: { returnId, returnedQuantity: moved },
    }),
  };
}

const DISPOSITION_EVENT = {
  usable: EVENT_TYPES.RETURN_RESTORED,
  damaged: EVENT_TYPES.RETURN_QUARANTINED,
  temperature_excursion: EVENT_TYPES.RETURN_QUARANTINED,
  missing: EVENT_TYPES.RETURN_WRITTEN_OFF,
};
const DISPOSITION_PHRASE = {
  usable: "confirmed usable and restored to available stock",
  damaged: "recorded as damaged and quarantined",
  temperature_excursion: "recorded as a temperature excursion and quarantined",
  missing: "recorded as missing and written off",
};

/** An Admin's disposition of a pending return. [order] may be null if it was deleted. */
function dispositionEvent({ returnId, ret, order, disposition, uid }) {
  const batches = (Array.isArray(ret.items) ? ret.items : []).map((r) => ({
    inventoryId: r.inventoryId ?? null,
    batchId: textOrNull(r.batchId),
    productKey: textOrNull(r.productKey),
    quantity: count(r.quantity),
  }));
  const qty = batches.reduce((s, b) => s + b.quantity, 0);
  const orderId = ret.orderId;
  const base = order ?? { orderNumber: ret.orderNumber ?? null, createdByUid: null, items: [] };
  return {
    eventId: eventIdOf(returnId, "disposition"),
    event: buildEvent({
      orderId,
      order: base,
      eventType: DISPOSITION_EVENT[disposition],
      sourceOperation: "confirmReturnDisposition",
      actor: actorOf(uid, "admin"),
      lines: [],
      batches,
      quantityChanged: qty,
      allocationStateAfter: order?.allocationState ?? null,
      summary: `Returned ${batchPhrase(batches)} ${DISPOSITION_PHRASE[disposition]}.`,
      extra: { returnId, disposition },
    }),
  };
}

/** A failed delivery sent back to the dispatch queue: every line waits for stock again. */
function requeueEvent({ orderId, order, afterItems, epoch, uid }) {
  const lines = afterItems.map(lineSnapshot);
  const t = totalsOf(lines);
  return {
    eventId: eventIdOf(orderId, `e${epoch}`, "requeue"),
    event: buildEvent({
      orderId,
      order: { ...order, items: afterItems },
      eventType: EVENT_TYPES.ORDER_REQUEUED,
      sourceOperation: "requeueFailedOrder",
      actor: actorOf(uid, "dispatcher"),
      lines,
      quantityChanged: 0,
      allocationStateAfter: "awaiting_stock",
      epoch,
      ordinal: 1,
      summary: `Requeued after the failed delivery: ${plural(t.backorderedQuantityAfter)} back in the allocation queue.`,
    }),
  };
}

module.exports = {
  RECEIPTS,
  ALLOCATION_EVENTS,
  RECEIPT_SCHEMA_VERSION,
  EVENT_SCHEMA_VERSION,
  EVENT_TYPES,
  SYSTEM_ACTOR,
  epochOf,
  eventIdOf,
  lineSnapshot,
  slicesByLine,
  buildEvent,
  IMMUTABLE_EVENT_FIELDS,
  RECEIPT_VOLATILE_FIELDS,
  canonical,
  immutableDiff,
  prepareEvents,
  createPreparedEvents,
  prepareReceipt,
  createPreparedReceipt,
  OUTBOX,
  initialHistoryMarker,
  initialAllocationEvent,
  buildOrderReceipt,
  buildReconstructedReceipt,
  orderPlacedEvent,
  allocationEvents,
  cancellationEvent,
  consumptionEvent,
  returnPendingEvent,
  dispositionEvent,
  requeueEvent,
};
