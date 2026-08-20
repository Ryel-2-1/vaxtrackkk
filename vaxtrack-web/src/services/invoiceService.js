import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import { db } from "../firebase";
import { getOrderStatusValue, normalizeStatusKey } from "./deliveryService";
import { assertConsistentInvoiceTotals } from "./invoiceModel";

const ORDERS = "orders";
const INVOICES = "invoices";
const COUNTERS = "counters";

// Orders that cannot be invoiced. Everything else that has been placed is
// eligible for invoice preparation (the project has no separate "approved"
// gate — a placed order is an approved customer order awaiting fulfilment).
const NON_ELIGIBLE_STATUSES = ["cancelled", "canceled"];

const VALID_PRIORITIES = ["Normal", "High", "Urgent"];
const PRIORITY_RANK = { Urgent: 3, High: 2, Normal: 1 };

// ---- VAT (Philippine sales invoice, VAT-EXCLUSIVE) ----
// The VAT helpers live in the dependency-free `invoiceModel.js` (so they are
// unit-testable under node --test without pulling in Firebase). Re-exported
// here so existing importers of `invoiceService` keep working unchanged.
export {
  VAT_STANDARD_RATE,
  VAT_CLASSIFICATIONS,
  vatClassificationLabel,
  computeVatExclusiveTotals,
} from "./invoiceModel";

function toMillis(ts) {
  return ts?.toMillis?.() ?? 0;
}

function orderPriority(order, invoice) {
  // Priority lives on the order (it applies to the queue position whether or
  // not an invoice draft exists yet). Fall back to the sales-rep order
  // priority, then Normal.
  const raw =
    order.invoicePriority ||
    invoice?.invoicePriority ||
    (String(order.priority || "").toLowerCase() === "urgent" ? "Urgent" : "Normal");
  return VALID_PRIORITIES.includes(raw) ? raw : "Normal";
}

function orderTotalQuantity(order) {
  if (Array.isArray(order.items) && order.items.length > 0) {
    return order.items.reduce((sum, it) => sum + (Number(it.quantity) || 0), 0);
  }
  return Number(order.quantity) || 0;
}

// Amount is only "real" when the order actually carries prices. Returns null
// when no price data exists so the UI can show a dash instead of ₱0.00.
function orderAmount(order) {
  if (Array.isArray(order.items) && order.items.length > 0) {
    const total = order.items.reduce(
      (sum, it) => sum + (Number(it.unitPrice) || 0) * (Number(it.quantity) || 0),
      0
    );
    return total > 0 ? total : null;
  }
  return null;
}

// Map an invoice document (or its absence) to a queue-level status label.
function queueInvoiceStatus(invoice) {
  if (!invoice) return "Pending";
  switch (invoice.invoiceStatus) {
    case "issued":
      return "Issued";
    case "cancelled":
      return "Cancelled";
    case "draft": {
      const hasItems = Array.isArray(invoice.items) && invoice.items.length > 0;
      const validTotal = Number(invoice.grandTotal) > 0;
      return hasItems && validTotal ? "Ready to Print" : "In Progress";
    }
    default:
      return "Pending";
  }
}

function buildQueueRow(order, invoice) {
  const statusKey = normalizeStatusKey(getOrderStatusValue(order));
  return {
    orderId: order.id,
    orderNumber: order.orderNumber || order.id.slice(0, 10).toUpperCase(),
    clinicName: order.clinicName || order.clinic || "—",
    clinicId: order.clinicId || null,
    salesRepName: order.salesRepName || order.createdByEmail || "—",
    salesRepUid: order.createdByUid || null,
    salesRepEmail: order.createdByEmail || null,
    orderDate: order.createdAt || null,
    orderDateMs: toMillis(order.createdAt),
    totalQuantity: orderTotalQuantity(order),
    unit: order.unit || "vials",
    amount: orderAmount(order),
    orderStatusKey: statusKey,
    priority: orderPriority(order, invoice),
    invoiceStatus: queueInvoiceStatus(invoice),
    invoiceId: invoice?.id || null,
    invoiceNumber: invoice?.invoiceNumber || null,
    issuedAtMs: toMillis(invoice?.issuedAt),
    // Invoice financials — present only once an invoice draft exists (null
    // otherwise). `vatAmount` falls back to a legacy `taxAmount`. Used by CSV
    // export; the queue table itself does not render these.
    invoiceDate: invoice?.invoiceDate || null,
    invoiceSubtotal: invoice ? Number(invoice.subtotal) || 0 : null,
    invoiceDiscount: invoice ? Number(invoice.discount) || 0 : null,
    invoiceOtherCharges: invoice ? Number(invoice.otherCharges) || 0 : null,
    invoiceVatClassification: invoice?.vatClassification || null,
    invoiceVatableSales: invoice ? Number(invoice.vatableSales) || 0 : null,
    invoiceVatExemptSales: invoice ? Number(invoice.vatExemptSales) || 0 : null,
    invoiceZeroRatedSales: invoice ? Number(invoice.zeroRatedSales) || 0 : null,
    invoiceVatAmount: invoice
      ? Number(invoice.vatAmount ?? invoice.taxAmount) || 0
      : null,
    invoiceGrandTotal: invoice ? Number(invoice.grandTotal) || 0 : null,
  };
}

/**
 * Live subscription to the invoice queue: every eligible order joined with its
 * invoice document (if one exists). Reads both collections in full and joins
 * client-side, so no composite index is required.
 *
 * Rows are sorted by priority (Urgent → High → Normal) then oldest order first.
 * Returns an unsubscribe function that detaches both listeners.
 */
export function subscribeInvoiceQueue(callback, onError) {
  let orders = [];
  let invoicesByOrder = {};
  let ordersLoaded = false;
  let invoicesLoaded = false;

  const emit = () => {
    if (!ordersLoaded || !invoicesLoaded) return;

    const rows = orders
      .filter((o) => !NON_ELIGIBLE_STATUSES.includes(normalizeStatusKey(getOrderStatusValue(o))))
      .map((o) => buildQueueRow(o, invoicesByOrder[o.id] || null))
      .sort((a, b) => {
        const rankDiff = (PRIORITY_RANK[b.priority] || 0) - (PRIORITY_RANK[a.priority] || 0);
        if (rankDiff !== 0) return rankDiff;
        return a.orderDateMs - b.orderDateMs; // oldest eligible order first
      });

    callback(rows);
  };

  const handleError = (label) => (error) => {
    console.error(`subscribeInvoiceQueue (${label}) error:`, error);
    if (onError) onError(error);
  };

  const unsubOrders = onSnapshot(
    collection(db, ORDERS),
    (snap) => {
      orders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      ordersLoaded = true;
      emit();
    },
    handleError("orders")
  );

  const unsubInvoices = onSnapshot(
    collection(db, INVOICES),
    (snap) => {
      invoicesByOrder = {};
      snap.docs.forEach((d) => {
        const data = d.data();
        if (data.orderId) invoicesByOrder[data.orderId] = { id: d.id, ...data };
      });
      invoicesLoaded = true;
      emit();
    },
    handleError("invoices")
  );

  return () => {
    unsubOrders();
    unsubInvoices();
  };
}

export async function getInvoiceByOrderId(orderId) {
  if (!orderId) return null;
  // Invoice doc id === orderId, which structurally guarantees one invoice per
  // order and prevents duplicates.
  const snap = await getDoc(doc(db, INVOICES, orderId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

/**
 * Create the first invoice draft for an order. Runs inside a transaction that:
 *   1. refuses to create a second invoice for the same order, and
 *   2. reserves a unique, sequential invoice number from a per-year counter
 *      (never derived from array length).
 * Returns { invoiceId, invoiceNumber }.
 */
export async function createInvoiceDraft(orderId, invoiceData, adminUser) {
  if (!orderId) throw new Error("Order ID is required.");
  // Totals must be derivable from the serialized items (never client-arbitrary).
  assertConsistentInvoiceTotals(invoiceData);

  const invRef = doc(db, INVOICES, orderId);
  const year = new Date().getFullYear();
  const counterRef = doc(db, COUNTERS, `invoice_${year}`);

  const invoiceNumber = await runTransaction(db, async (tx) => {
    // All reads must happen before any writes in a transaction.
    const invSnap = await tx.get(invRef);
    if (invSnap.exists()) {
      throw new Error("An invoice already exists for this order.");
    }

    const counterSnap = await tx.get(counterRef);
    const next = (counterSnap.exists() ? Number(counterSnap.data().current) || 0 : 0) + 1;
    const number = `INV-${year}-${String(next).padStart(6, "0")}`;

    tx.set(counterRef, { current: next, updatedAt: serverTimestamp() }, { merge: true });
    tx.set(invRef, {
      ...invoiceData,
      invoiceNumber: number,
      orderId,
      invoiceStatus: "draft",
      createdAt: serverTimestamp(),
      createdByUid: adminUser?.uid || null,
      createdByEmail: adminUser?.email || null,
      updatedAt: serverTimestamp(),
      updatedByUid: adminUser?.uid || null,
      updatedByEmail: adminUser?.email || null,
    });

    return number;
  });

  return { invoiceId: orderId, invoiceNumber };
}

/**
 * Update an existing draft. Refuses to edit an already-issued invoice so issued
 * numbers/values stay locked. Preserves unrelated fields (only merges the
 * provided invoiceData + audit fields).
 */
export async function updateInvoiceDraft(invoiceId, invoiceData, adminUser) {
  if (!invoiceId) throw new Error("Invoice ID is required.");

  const invRef = doc(db, INVOICES, invoiceId);
  const snap = await getDoc(invRef);
  if (!snap.exists()) throw new Error("Invoice draft not found.");
  if (snap.data().invoiceStatus === "issued") {
    throw new Error("Issued invoices cannot be edited.");
  }
  assertConsistentInvoiceTotals(invoiceData);

  // Never let the caller overwrite the reserved number, the create-audit trail,
  // the identity (orderId), or the status via a draft save.
  const safe = { ...(invoiceData || {}) };
  delete safe.invoiceNumber;
  delete safe.createdAt;
  delete safe.createdByUid;
  delete safe.createdByEmail;
  delete safe.orderId;
  delete safe.invoiceStatus;

  return updateDoc(invRef, {
    ...safe,
    updatedAt: serverTimestamp(),
    updatedByUid: adminUser?.uid || null,
    updatedByEmail: adminUser?.email || null,
  });
}

/**
 * Set the queue priority for an order. Stored on the order document so priority
 * exists even before an invoice draft is created. Only adds invoice-priority
 * fields; unrelated order fields are preserved.
 */
export async function updateInvoicePriority(orderId, priority, adminUser) {
  if (!orderId) throw new Error("Order ID is required.");
  if (!VALID_PRIORITIES.includes(priority)) {
    throw new Error(`Invalid priority: ${priority}`);
  }

  return updateDoc(doc(db, ORDERS, orderId), {
    invoicePriority: priority,
    invoicePriorityUpdatedAt: serverTimestamp(),
    invoicePriorityUpdatedByUid: adminUser?.uid || null,
    invoicePriorityUpdatedByEmail: adminUser?.email || null,
  });
}

/**
 * Mark an invoice as issued. Runs in a transaction that blocks a second
 * issuance and validates the invoice has usable items/total before locking it.
 */
export async function issueInvoice(invoiceId, adminUser) {
  if (!invoiceId) throw new Error("Invoice ID is required.");

  const invRef = doc(db, INVOICES, invoiceId);

  return runTransaction(db, async (tx) => {
    const snap = await tx.get(invRef);
    if (!snap.exists()) throw new Error("Invoice not found.");

    const data = snap.data();
    if (data.invoiceStatus === "issued") {
      throw new Error("This invoice has already been issued.");
    }

    const items = Array.isArray(data.items) ? data.items : [];
    if (items.length === 0) {
      throw new Error("Add at least one invoice item before issuing.");
    }
    const invalidLine = items.some(
      (it) => !(Number(it.quantity) > 0) || Number(it.unitPrice) < 0
    );
    if (invalidLine) {
      throw new Error("Every item needs a quantity greater than zero and a valid price.");
    }
    // The stored totals must still match the stored line items (nothing was
    // tampered between the last draft save and issuance).
    assertConsistentInvoiceTotals(data);

    tx.update(invRef, {
      invoiceStatus: "issued",
      issuedAt: serverTimestamp(),
      issuedByUid: adminUser?.uid || null,
      issuedByEmail: adminUser?.email || null,
      updatedAt: serverTimestamp(),
      updatedByUid: adminUser?.uid || null,
      updatedByEmail: adminUser?.email || null,
    });
  });
}
