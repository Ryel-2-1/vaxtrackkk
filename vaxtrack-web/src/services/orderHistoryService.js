import {
  collection,
  doc,
  documentId,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  startAfter,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import { HISTORY_PAGE_SIZE, manilaDayEnd, manilaDayStart } from "./orderHistory.js";

/**
 * Read-only queries for Order Receipt History and Stock Allocation History.
 *
 * Nothing here writes: receipts and allocation events are created only by the
 * trusted server (functions/src/orderHistory.js) and firestore.rules refuse
 * every client write. A Med Rep's queries always filter on their own uid — the
 * rules require it — while Admin queries may span every Med Rep.
 *
 * Indexes (firestore.indexes.json):
 *   orders                      createdByUid ↑, createdAt ↓   (a Med Rep's history)
 *   orders                      createdAt ↓                   (single-field, Admin)
 *   inventoryAllocationEvents   orderId ↑, createdAt ↑         (Admin timeline)
 *   inventoryAllocationEvents   medRepUid ↑, orderId ↑, createdAt ↑ (Med Rep timeline)
 *   inventoryAllocationEvents   batchIds ∋, createdAt ↓        (Admin batch search)
 *   orderReceipts               skus ∋, createdAt ↓            (Admin SKU search)
 */

const ORDERS = "orders";
const RECEIPTS = "orderReceipts";
const EVENTS = "inventoryAllocationEvents";
const IN_LIMIT = 30;

const withId = (d) => ({ ...d.data(), id: d.id });

function chunks(values, size = IN_LIMIT) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/**
 * One page of orders, newest first — every accepted order regardless of its
 * current status. [medRepUid] scopes it to one Med Rep (required for a Med
 * Rep; optional for Admin). [dateFrom]/[dateTo] are Manila calendar days.
 * Returns { orders, cursor, hasMore }; pass `cursor` back for the next page.
 */
export async function fetchOrderHistoryPage({ medRepUid = null, dateFrom = "", dateTo = "", cursor = null, pageSize = HISTORY_PAGE_SIZE } = {}) {
  const parts = [];
  if (medRepUid) parts.push(where("createdByUid", "==", medRepUid));
  const from = manilaDayStart(dateFrom);
  const to = manilaDayEnd(dateTo);
  if (from) parts.push(where("createdAt", ">=", from));
  if (to) parts.push(where("createdAt", "<", to));
  parts.push(orderBy("createdAt", "desc"));
  if (cursor) parts.push(startAfter(cursor));
  parts.push(limit(pageSize));
  const snap = await getDocs(query(collection(db, ORDERS), ...parts));
  return {
    orders: snap.docs.map(withId),
    cursor: snap.docs.length ? snap.docs[snap.docs.length - 1] : cursor,
    hasMore: snap.docs.length === pageSize,
  };
}

/**
 * Receipts for the given orders, as Map(orderId → receipt). Orders without a
 * receipt (legacy) are simply absent. A query, not per-id gets: a Med Rep may
 * not `get` a receipt that does not exist, so absence must come back as an
 * empty result rather than a denial.
 */
export async function fetchReceiptsForOrders(orderIds, medRepUid = null) {
  const map = new Map();
  const ids = [...new Set(orderIds.filter(Boolean))];
  for (const part of chunks(ids)) {
    const parts = [where("orderId", "in", part)];
    if (medRepUid) parts.unshift(where("medRepUid", "==", medRepUid));
    const snap = await getDocs(query(collection(db, RECEIPTS), ...parts));
    for (const d of snap.docs) map.set(d.id, withId(d));
  }
  return map;
}

/** The live allocation ledger of one order, oldest first. */
export function subscribeAllocationEvents(orderId, medRepUid, callback, onError) {
  const parts = [];
  if (medRepUid) parts.push(where("medRepUid", "==", medRepUid));
  parts.push(where("orderId", "==", orderId), orderBy("createdAt", "asc"), limit(500));
  return onSnapshot(
    query(collection(db, EVENTS), ...parts),
    (snap) => callback(snap.docs.map(withId)),
    (err) => {
      console.error("Allocation history subscription error:", err?.code || err);
      if (onError) onError(err);
    }
  );
}

/** The live order document, for the Current Fulfillment Summary. */
export function subscribeOrder(orderId, callback, onError) {
  return onSnapshot(
    doc(db, ORDERS, orderId),
    (snap) => callback(snap.exists() ? withId(snap) : null),
    (err) => {
      console.error("Order subscription error:", err?.code || err);
      if (onError) onError(err);
    }
  );
}

/** Orders by their FULL reference (exact match). Scoped to a Med Rep when given. */
export async function findOrdersByReference(reference, medRepUid = null) {
  const value = String(reference || "").trim().toUpperCase();
  if (!value) return [];
  const parts = [where("orderNumber", "==", value)];
  if (medRepUid) parts.unshift(where("createdByUid", "==", medRepUid));
  const snap = await getDocs(query(collection(db, ORDERS), ...parts, limit(10)));
  return snap.docs.map(withId);
}

/** Admin: orders whose receipt lists the SKU (canonical internalSku, exact). */
export async function findOrderIdsBySku(sku) {
  const value = String(sku || "").trim();
  if (!value) return [];
  const snap = await getDocs(query(collection(db, RECEIPTS), where("skus", "array-contains", value), orderBy("createdAt", "desc"), limit(50)));
  return snap.docs.map((d) => d.id);
}

/** Admin: orders an allocation event proves touched the Batch ID (exact). */
export async function findOrderIdsByBatchId(batchId) {
  const value = String(batchId || "").trim().toUpperCase();
  if (!value) return [];
  const snap = await getDocs(query(collection(db, EVENTS), where("batchIds", "array-contains", value), orderBy("createdAt", "desc"), limit(200)));
  return [...new Set(snap.docs.map((d) => d.data().orderId).filter(Boolean))];
}

/** Admin: orders by document id, newest first. */
export async function fetchOrdersByIds(orderIds) {
  const out = [];
  for (const part of chunks([...new Set(orderIds.filter(Boolean))])) {
    const snap = await getDocs(query(collection(db, ORDERS), where(documentId(), "in", part)));
    out.push(...snap.docs.map(withId));
  }
  return out.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
}

/** Admin: Med Reps, for the Med Rep filter (bounded like every query here). */
export const MED_REP_LIMIT = 500;
export async function fetchMedReps() {
  const snap = await getDocs(query(collection(db, "users"), where("role", "==", "salesrep"), limit(MED_REP_LIMIT)));
  return snap.docs
    .map(withId)
    .map((u) => ({ uid: u.id, label: u.name || u.fullName || u.displayName || u.email || u.id }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
