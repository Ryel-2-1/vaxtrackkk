"use strict";

/**
 * Inventory allocation: future orders, partial reservation, priority and FEFO.
 *
 * MODEL (orders with allocationVersion 2)
 *
 *   An order line is DEMAND for a product (`productKey` = the batch's
 *   `vaccineId`, the vaccines-catalog document id). The line still carries the
 *   batch it was QUOTED from (`inventoryId`, price snapshot, VAT snapshot) —
 *   that never changes — but which physical batches are reserved for it is
 *   decided here, per product, FEFO.
 *
 *     line.quantity            requested
 *     line.reservedQuantity    units currently reserved for this line
 *     line.backorderedQuantity requested − reserved, while the order is open
 *
 *   order.allocationState   awaiting_stock | partially_reserved | fully_reserved
 *   order.allocationOpen    true while the order may receive stock
 *   order.backorderedProductKeys  products this order still waits for (the
 *                           queue index: array-contains + allocationPriorityKey)
 *   order.allocationPriorityKey   sortable string, see allocationPriorityKey()
 *
 *   inventoryReservations/{orderId}.items  one SLICE per (line, batch):
 *     { lineIndex, productKey, inventoryId, batchId, quantity }
 *   inventoryReservations/{orderId}.inventoryIds  batches it touches (provenance)
 *
 * BATCH COUNTERS (inventory/{id})
 *
 *   quantity              on hand: units the business physically holds
 *   reservedQuantity      claimed by active reservations
 *   returnPendingQuantity back from a failed delivery, awaiting disposition
 *   quarantinedQuantity   damaged / temperature excursion — never allocated
 *
 *   available = quantity − reserved − returnPending − quarantined  (derived)
 *
 * PRIORITY (one comparator, everywhere)
 *
 *   1. Urgent before Standard
 *   2. earliest requested delivery date (then scheduled time); a missing or
 *      invalid date sorts AFTER every valid date
 *   3. oldest createdAt
 *   4. order document id ascending
 *
 * Only orders still awaiting dispatch (`pending_dispatch`) and open for
 * allocation take part. Assignment, loading and dispatch require
 * fully_reserved (operations + firestore.rules), so an order never leaves the
 * queue half-filled.
 */

// The same usability and date rules the order path applies (policy.js), so a
// batch is never allocatable here while being unorderable there.
const { isUsableStatus, isoDateOnly, manilaDateString, isUnconfirmedStockQuantity } = require("./policy");

const ALLOCATION_VERSION_BACKORDER = 2;
const ALLOCATION_STATES = Object.freeze(["awaiting_stock", "partially_reserved", "fully_reserved"]);
const ALLOCATABLE_ORDER_STATUSES = Object.freeze(["pending_dispatch"]);

/**
 * Bounds. One TRANSACTION reads at most one page of batches and one page of
 * orders (plus those orders' reservations) and writes at most
 * MAX_BATCHES_PER_PRODUCT + 2 × MAX_ORDERS_PER_ROUND documents. One RUN is at
 * most MAX_ROUNDS transactions; work left after that is handed to a
 * continuation (see allocateProduct), never to an unbounded loop.
 */
const MAX_BATCHES_PER_PRODUCT = 100;
const MAX_ORDERS_PER_ROUND = 25;
const MAX_ROUNDS = 20;
/** Hard ceiling on one continuation chain (each link must have made progress). */
const MAX_CONTINUATIONS = 200;
const CONTINUATIONS = "allocationContinuations";

// ---------------------------------------------------------------- counters

/** A non-negative integer counter; absent means zero; anything else is corrupt. */
function readCounter(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: 0 };
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return { ok: true, value: raw };
  return { ok: false, value: null };
}

/**
 * The batch's units that may be allocated right now, or 0 when the batch is
 * unusable. Unusable: corrupt counters, an on-hand figure above the
 * MAX_STOCK_QUANTITY ceiling (unconfirmed), a status outside USABLE_STATUSES
 * (disabled, quarantined, critical …), a missing/invalid expiry, or expired
 * (Manila calendar day). return-pending and quarantined units never count.
 */
function allocatableUnits(data, now) {
  if (!data) return 0;
  const onHand = readCounter(data.quantity);
  const reserved = readCounter(data.reservedQuantity);
  const returning = readCounter(data.returnPendingQuantity);
  const quarantined = readCounter(data.quarantinedQuantity);
  if (!onHand.ok || !reserved.ok || !returning.ok || !quarantined.ok) return 0;
  // An on-hand figure above the Add Stock ceiling is unconfirmed, not stock.
  if (isUnconfirmedStockQuantity(onHand.value)) return 0;
  if (!isUsableStatus(data.status)) return 0;
  const expiry = isoDateOnly(data.expiryDate);
  if (expiry === null || expiry < manilaDateString(now)) return 0;
  const available = onHand.value - reserved.value - returning.value - quarantined.value;
  return available > 0 ? available : 0;
}

/** First-expiry-first-out; ties by arrival date, then document id. */
function compareFefo(a, b) {
  const ea = isoDateOnly(a.data.expiryDate) ?? "9999-12-31";
  const eb = isoDateOnly(b.data.expiryDate) ?? "9999-12-31";
  if (ea !== eb) return ea < eb ? -1 : 1;
  const ra = isoDateOnly(a.data.arrivalDate) ?? "9999-12-31";
  const rb = isoDateOnly(b.data.arrivalDate) ?? "9999-12-31";
  if (ra !== rb) return ra < rb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------- priority

function millisOf(value) {
  if (value == null) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

const NO_DATE = "9999-12-31";
const NO_TIME = "99:99";
const NO_CREATED = 999999999999999;

/** The normalized priority tuple of an order. */
function priorityTuple(order, orderId) {
  const urgent = String(order?.priority ?? "").trim().toLowerCase() === "urgent";
  const date = isoDateOnly(order?.requestedDeliveryDate) ?? NO_DATE;
  const time =
    typeof order?.scheduledDeliveryTime === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(order.scheduledDeliveryTime)
      ? order.scheduledDeliveryTime
      : NO_TIME;
  const created = millisOf(order?.allocationCreatedAtMillis ?? order?.createdAt) ?? NO_CREATED;
  return { urgent, date, time, created, id: String(orderId ?? "") };
}

/** The canonical comparator: negative when `a` must be served before `b`. */
function compareAllocationPriority(a, b) {
  if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.time !== b.time) return a.time < b.time ? -1 : 1;
  if (a.created !== b.created) return a.created < b.created ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The same ordering as a string, so the queue can be read with an indexed
 * orderBy. Lexicographic order of keys == compareAllocationPriority.
 */
function allocationPriorityKey(order, orderId) {
  const t = priorityTuple(order, orderId);
  const created = Math.max(0, Math.min(NO_CREATED, Math.trunc(t.created)));
  return [t.urgent ? "0" : "1", t.date, t.time, String(created).padStart(15, "0"), t.id].join("|");
}

// ---------------------------------------------------------------- lines

/** Requested/reserved/backordered for one line, normalized. */
function lineCounts(line) {
  const requested = Number.isInteger(line?.quantity) && line.quantity > 0 ? line.quantity : 0;
  const reserved = Number.isInteger(line?.reservedQuantity) && line.reservedQuantity > 0 ? line.reservedQuantity : 0;
  return { requested, reserved: Math.min(reserved, requested), backordered: Math.max(0, requested - reserved) };
}

/** allocationState + queue keys for a set of lines. */
function summarizeAllocation(items, { open = true } = {}) {
  let anyReserved = false;
  let allReserved = items.length > 0;
  const keys = new Set();
  for (const line of items) {
    const c = lineCounts(line);
    if (c.reserved > 0) anyReserved = true;
    if (c.backordered > 0) {
      allReserved = false;
      if (open && typeof line.productKey === "string" && line.productKey) keys.add(line.productKey);
    }
  }
  return {
    allocationState: allReserved ? "fully_reserved" : anyReserved ? "partially_reserved" : "awaiting_stock",
    backorderedProductKeys: [...keys].sort(),
  };
}

/** A new order's lines: everything backordered until the engine runs. */
function initialAllocationLines(items) {
  return items.map((line) => ({
    ...line,
    reservedQuantity: 0,
    backorderedQuantity: line.quantity,
  }));
}

function isAllocatableOrder(order) {
  return (
    order?.allocationVersion === ALLOCATION_VERSION_BACKORDER &&
    order.allocationOpen === true &&
    ALLOCATABLE_ORDER_STATUSES.includes(order.status)
  );
}

// ---------------------------------------------------------------- planner (pure)

/**
 * Decide how to give [productKey]'s allocatable stock to waiting orders.
 *
 * [batches]  [{ id, data }]  every batch of the product (any state)
 * [orders]   [{ id, data }]  candidate orders (any order; filtered here)
 * Returns the batch counter changes, the per-order line changes and slices,
 * and a summary. Writes nothing.
 */
function planAllocation({ productKey, batches, orders, now }) {
  const pool = batches
    .filter((b) => b.data && b.data.vaccineId === productKey)
    .map((b) => ({ ...b, free: allocatableUnits(b.data, now) }))
    .filter((b) => b.free > 0)
    .sort(compareFefo);
  const startingAvailable = pool.reduce((s, b) => s + b.free, 0);

  const queue = orders
    .filter((o) => isAllocatableOrder(o.data))
    .map((o) => ({ ...o, tuple: priorityTuple(o.data, o.id) }))
    .sort((a, b) => compareAllocationPriority(a.tuple, b.tuple));

  const reservedDelta = new Map(); // inventoryId -> units added
  const orderUpdates = [];
  let allocatedUnits = 0;

  for (const order of queue) {
    if (pool.every((b) => b.free === 0)) break;
    const items = (Array.isArray(order.data.items) ? order.data.items : []).map((l) => ({ ...l }));
    const slices = [];
    let got = 0;
    items.forEach((line, lineIndex) => {
      if (line.productKey !== productKey) return;
      const c = lineCounts(line);
      let need = c.backordered;
      for (const batch of pool) {
        if (need === 0) break;
        if (batch.free === 0) continue;
        const take = Math.min(need, batch.free);
        batch.free -= take;
        need -= take;
        got += take;
        reservedDelta.set(batch.id, (reservedDelta.get(batch.id) ?? 0) + take);
        slices.push({
          lineIndex,
          productKey,
          inventoryId: batch.id,
          batchId: typeof batch.data.batchId === "string" ? batch.data.batchId : null,
          quantity: take,
        });
      }
      const reserved = c.reserved + (c.backordered - need);
      line.reservedQuantity = reserved;
      line.backorderedQuantity = c.requested - reserved;
    });
    if (got === 0) continue;
    allocatedUnits += got;
    orderUpdates.push({
      orderId: order.id,
      orderNumber: order.data.orderNumber ?? null,
      units: got,
      items,
      slices,
      ...summarizeAllocation(items, { open: true }),
    });
  }

  const batchUpdates = [];
  for (const [id, delta] of reservedDelta) {
    const b = batches.find((x) => x.id === id);
    const reserved = readCounter(b.data.reservedQuantity).value;
    batchUpdates.push({ id, reservedQuantity: reserved + delta, delta });
  }
  return {
    productKey,
    allocatedUnits,
    startingAvailable,
    leftAvailable: startingAvailable - allocatedUnits,
    batchUpdates,
    orderUpdates,
  };
}

/** Merge new slices into a reservation's slices (same line+batch summed). */
function mergeSlices(existing, added) {
  const out = (Array.isArray(existing) ? existing : []).map((s) => ({ ...s }));
  for (const s of added) {
    const hit = out.find((e) => e.lineIndex === s.lineIndex && e.inventoryId === s.inventoryId);
    if (hit) hit.quantity += s.quantity;
    else out.push({ ...s });
  }
  return out;
}

/** Units per batch across a reservation's slices (one counter update per batch). */
function unitsByBatch(slices) {
  const map = new Map();
  for (const s of Array.isArray(slices) ? slices : []) {
    if (typeof s?.inventoryId !== "string" || !Number.isInteger(s.quantity) || s.quantity <= 0) continue;
    map.set(s.inventoryId, (map.get(s.inventoryId) ?? 0) + s.quantity);
  }
  return map;
}

// ---------------------------------------------------------------- transaction

/**
 * One allocation round for [productKey] inside [tx]: bounded reads, then the
 * writes.
 *
 *   batches  one PAGE of the product's batches in expiry order (FEFO across
 *            pages), starting after [batchCursor] — batches before the cursor
 *            were already exhausted earlier in this run.
 *   orders   one PAGE of open waiting orders in priority order, starting after
 *            [orderCursor] — orders before it could not take this product's
 *            stock earlier in this run.
 *
 * Only string 'YYYY-MM-DD' expiries are allocatable (policy.isoDateOnly), and
 * those sort chronologically, so ordering by expiryDate pages FEFO. A batch
 * with no expiry field is unallocatable and is (correctly) not read at all.
 *
 * [extraBatches] are batches created in the same transaction and not yet
 * readable — their reserved units are returned for the caller to write.
 */
async function allocateInTransaction(tx, {
  db,
  FieldValue,
  productKey,
  now,
  extraBatches = [],
  maxOrders = MAX_ORDERS_PER_ROUND,
  maxBatches = MAX_BATCHES_PER_PRODUCT,
  batchCursor = null,
  orderCursor = null,
}) {
  let batchQuery = db
    .collection("inventory")
    .where("vaccineId", "==", productKey)
    .orderBy("expiryDate")
    .orderBy("__name__")
    .limit(maxBatches);
  if (batchCursor) batchQuery = batchQuery.startAfter(batchCursor.expiryDate, batchCursor.id);
  let orderQuery = db
    .collection("orders")
    .where("backorderedProductKeys", "array-contains", productKey)
    .where("allocationOpen", "==", true)
    .orderBy("allocationPriorityKey")
    .limit(maxOrders);
  if (orderCursor) orderQuery = orderQuery.startAfter(orderCursor);

  const batchSnap = await tx.get(batchQuery);
  const orderSnap = await tx.get(orderQuery);
  const resSnaps = [];
  for (const d of orderSnap.docs) resSnaps.push(await tx.get(db.collection("inventoryReservations").doc(d.id)));

  const batches = batchSnap.docs.map((d) => ({ id: d.id, data: d.data() })).concat(extraBatches);
  const orders = orderSnap.docs.map((d) => ({ id: d.id, data: d.data() }));
  const plan = planAllocation({ productKey, batches, orders, now });

  const extraIds = new Set(extraBatches.map((b) => b.id));
  const extraReserved = new Map();
  for (const u of plan.batchUpdates) {
    if (extraIds.has(u.id)) extraReserved.set(u.id, u.reservedQuantity);
    else tx.update(db.collection("inventory").doc(u.id), { reservedQuantity: u.reservedQuantity });
  }
  for (const u of plan.orderUpdates) {
    const resIdx = orderSnap.docs.findIndex((d) => d.id === u.orderId);
    const res = resSnaps[resIdx];
    const slices = mergeSlices(res.exists ? res.data().items : [], u.slices);
    tx.update(db.collection("orders").doc(u.orderId), {
      items: u.items,
      allocationState: u.allocationState,
      backorderedProductKeys: u.backorderedProductKeys,
      allocationUpdatedAt: FieldValue.serverTimestamp(),
      ...(u.allocationState === "fully_reserved" ? { fullyReservedAt: FieldValue.serverTimestamp() } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(
      db.collection("inventoryReservations").doc(u.orderId),
      {
        orderId: u.orderId,
        allocationVersion: ALLOCATION_VERSION_BACKORDER,
        status: "reserved",
        items: slices,
        inventoryIds: [...new Set(slices.map((s) => s.inventoryId))].sort(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }
  const lastBatch = batchSnap.docs[batchSnap.size - 1];
  const lastOrder = orderSnap.docs[orderSnap.size - 1];
  return {
    ...plan,
    extraReserved,
    orderCount: orderSnap.size,
    orderPageFull: orderSnap.size === maxOrders,
    batchPageFull: batchSnap.size === maxBatches,
    lastBatch: lastBatch ? { expiryDate: lastBatch.get("expiryDate"), id: lastBatch.id } : null,
    lastOrderKey: lastOrder ? lastOrder.get("allocationPriorityKey") : null,
  };
}

/**
 * What a run does after one round — PURE, so the termination and progress
 * argument is testable on its own.
 *
 * Every non-final step makes progress: it either allocated units (finite) or
 * moves a cursor strictly forward over a finite, ordered page sequence. So a
 * run cannot spin, and stock is never left idle while an eligible order exists
 * further down the queue or a usable batch exists further down the pages:
 *
 *   no orders from the cursor on            → done (no demand left)
 *   stock left on this batch page:
 *     order page not full                   → done (every remaining order was
 *                                             on this page and was served)
 *     order page full, nothing allocated    → skip the order page (none of
 *                                             those orders can take it)
 *     order page full, units allocated      → re-read the same order page
 *                                             (served orders leave the queue)
 *   no stock left on this batch page:
 *     batch page not full                   → done (no further batches)
 *     batch page full                       → next batch page (this one is
 *                                             exhausted for the rest of the run)
 */
function nextAllocationStep(round, cursors) {
  const next = { done: false, batchCursor: cursors.batchCursor ?? null, orderCursor: cursors.orderCursor ?? null };
  if (round.orderCount === 0) return { ...next, done: true };
  if (round.leftAvailable > 0) {
    if (!round.orderPageFull) return { ...next, done: true };
    if (round.allocatedUnits === 0) return { ...next, orderCursor: round.lastOrderKey };
    return next;
  }
  if (!round.batchPageFull) return { ...next, done: true };
  return { ...next, batchCursor: round.lastBatch };
}

/**
 * Allocate [productKey] until stock or demand runs out — or no progress is
 * possible — in bounded rounds, each its own transaction (nextAllocationStep).
 *
 * Safe to call any number of times, concurrently: every round re-reads the
 * counters inside its transaction, so stock can never be reserved twice, and a
 * round with nothing to do writes nothing.
 *
 * If MAX_ROUNDS pass with work still possible, the run records a CONTINUATION
 * (allocationContinuations/{productKey}: its cursors and a generation count);
 * the continueAllocation trigger resumes from there. A continuation is written
 * only when this run made progress, and a chain stops at MAX_CONTINUATIONS, so
 * chains always terminate.
 */
async function allocateProduct({
  db,
  FieldValue,
  productKey,
  now,
  maxRounds = MAX_ROUNDS,
  maxOrders = MAX_ORDERS_PER_ROUND,
  maxBatches = MAX_BATCHES_PER_PRODUCT,
  cursors = {},
  generation = 0,
}) {
  const summary = {
    productKey,
    allocatedUnits: 0,
    rounds: 0,
    allocations: [],
    leftAvailable: null,
    done: false,
    continued: false,
  };
  if (typeof productKey !== "string" || productKey === "" || productKey.includes("/")) {
    summary.done = true;
    return summary;
  }
  let state = { batchCursor: cursors.batchCursor ?? null, orderCursor: cursors.orderCursor ?? null };
  let progressed = false;
  for (let round = 0; round < maxRounds; round += 1) {
    const r = await db.runTransaction((tx) =>
      allocateInTransaction(tx, { db, FieldValue, productKey, now, maxOrders, maxBatches, ...state })
    );
    summary.rounds += 1;
    summary.leftAvailable = r.leftAvailable;
    summary.allocatedUnits += r.allocatedUnits;
    for (const u of r.orderUpdates) {
      summary.allocations.push({ orderId: u.orderId, orderNumber: u.orderNumber, units: u.units, allocationState: u.allocationState });
    }
    const step = nextAllocationStep(r, state);
    if (r.allocatedUnits > 0 || step.batchCursor !== state.batchCursor || step.orderCursor !== state.orderCursor) {
      progressed = true;
    }
    state = { batchCursor: step.batchCursor, orderCursor: step.orderCursor };
    if (step.done) {
      summary.done = true;
      break;
    }
  }
  summary.cursors = state;
  if (!summary.done && progressed) {
    summary.continued = await requestContinuation({ db, FieldValue, productKey, cursors: state, generation: generation + 1 });
  }
  return summary;
}

/**
 * Hand the rest of a run to the continueAllocation trigger. Returns false (and
 * writes nothing) once a chain reaches MAX_CONTINUATIONS — reported by the
 * caller's logs, never looped past.
 */
async function requestContinuation({ db, FieldValue, productKey, cursors, generation }) {
  if (generation > MAX_CONTINUATIONS) {
    console.error(`allocation continuation limit reached for ${productKey}`);
    return false;
  }
  await db.collection(CONTINUATIONS).doc(productKey).set({
    productKey,
    status: "pending",
    generation,
    batchCursor: cursors.batchCursor ?? null,
    orderCursor: cursors.orderCursor ?? null,
    requestedAt: FieldValue.serverTimestamp(),
  });
  return true;
}

/**
 * The continueAllocation trigger body: resume one pending continuation. A
 * redelivered or stale event is harmless — the run re-reads everything — and a
 * finished chain is marked done so its own write does not resume it.
 */
async function runContinuation({ db, FieldValue, productKey, data, now, maxRounds = MAX_ROUNDS }) {
  if (!data || data.status !== "pending") return null;
  const generation = Number.isInteger(data.generation) ? data.generation : 1;
  const result = await allocateProduct({
    db,
    FieldValue,
    productKey,
    now,
    cursors: { batchCursor: data.batchCursor ?? null, orderCursor: data.orderCursor ?? null },
    generation,
    maxRounds,
  });
  if (!result.continued) {
    // Only close the record this event opened; a newer request stays pending.
    await db.runTransaction(async (tx) => {
      const ref = db.collection(CONTINUATIONS).doc(productKey);
      const snap = await tx.get(ref);
      if (snap.exists && snap.get("status") === "pending" && snap.get("generation") === generation) {
        tx.update(ref, { status: result.done ? "done" : "stalled", finishedAt: FieldValue.serverTimestamp() });
      }
    });
  }
  return result;
}

/** Allocate several products independently; one shortage never blocks another. */
async function allocateProducts({ db, FieldValue, productKeys, now }) {
  const results = [];
  for (const key of [...new Set(productKeys)].filter(Boolean).sort()) {
    results.push(await allocateProduct({ db, FieldValue, productKey: key, now }));
  }
  return results;
}

module.exports = {
  MAX_BATCHES_PER_PRODUCT,
  MAX_ROUNDS,
  MAX_CONTINUATIONS,
  CONTINUATIONS,
  nextAllocationStep,
  requestContinuation,
  runContinuation,
  ALLOCATION_VERSION_BACKORDER,
  ALLOCATION_STATES,
  ALLOCATABLE_ORDER_STATUSES,
  MAX_ORDERS_PER_ROUND,
  readCounter,
  allocatableUnits,
  compareFefo,
  priorityTuple,
  compareAllocationPriority,
  allocationPriorityKey,
  lineCounts,
  summarizeAllocation,
  initialAllocationLines,
  isAllocatableOrder,
  planAllocation,
  mergeSlices,
  unitsByBatch,
  allocateInTransaction,
  allocateProduct,
  allocateProducts,
};
