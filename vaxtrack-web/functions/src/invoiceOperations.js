"use strict";

/**
 * The two invoice operations for SERVER-PRICED orders, as Admin SDK transactions.
 *
 * Deliberately NOT a generic "write invoice" callable. Each of these does one
 * named thing to one order's invoice, and neither accepts a base price from the
 * caller — a generic mutation entry point would hand the pricing back to the
 * client, which is exactly what this boundary removes.
 *
 * Orders WITHOUT a pricingVersion never come here. They keep the existing
 * client-side manual path (createInvoiceDraft / updateInvoiceDraft /
 * issueInvoice in src/services/invoiceService.js), unchanged.
 *
 * `db`, `FieldValue` and `now` are injected so the layer runs against the
 * Firestore emulator directly. Every callback is pure with respect to state
 * outside it, because Firestore retries a transaction on contention.
 */

const { PolicyError } = require("./policy");
const {
  buildInvoiceBaseFromOrder,
  baseMatchesOrder,
  centavosToPesos,
  computeInvoiceTotalsCentavos,
  validateAdjustments,
  validatePresentation,
} = require("./invoicePricing");
const { loadUser, requireRole, COLLECTIONS } = require("./operations");

const INVOICES = "invoices";
const COUNTERS = "counters";
const { ORDERS } = COLLECTIONS;

function requireOrderId(orderId) {
  if (typeof orderId !== "string" || orderId.trim() === "" || orderId.includes("/")) {
    throw new PolicyError("invalid-payload", "That order could not be identified.");
  }
  return orderId;
}

/**
 * The stored invoice document, assembled from the order's base pricing plus the
 * admin's presentation and adjustments.
 *
 * Both centavo figures and peso mirrors are written: centavos are the
 * authoritative record, and the pesos keep the existing print template, the CSV
 * export and every already-issued invoice reading exactly as they do today.
 */
function buildInvoiceDocument({ orderId, order, base, adjustments, totals, presentation }) {
  return {
    ...presentation,

    orderId,
    orderNumber: order.orderNumber || orderId,
    customerId: order.clinicId || null,
    clinicId: order.clinicId || null,
    salesRepUid: order.createdByUid || null,
    salesRepEmail: order.createdByEmail || null,

    // ---- base pricing: from the order, never from the caller ----
    items: base.items,
    subtotalCentavos: base.subtotalCentavos,
    subtotal: base.subtotal,
    priceCurrency: base.priceCurrency,
    priceIsVatInclusive: base.priceIsVatInclusive,
    pricingVersion: base.pricingVersion,
    // Says how this invoice was priced, so a reader never has to infer it from
    // the presence of a field.
    invoicePricingSource: "order-snapshot",

    // ---- adjustments: explicitly the admin's, and separate from the base ----
    discountCentavos: adjustments.discountCentavos,
    otherChargesCentavos: adjustments.otherChargesCentavos,
    withholdingTaxCentavos: adjustments.withholdingTaxCentavos,
    vatClassification: adjustments.vatClassification,
    discount: centavosToPesos(adjustments.discountCentavos),
    otherCharges: centavosToPesos(adjustments.otherChargesCentavos),
    withholdingTax: centavosToPesos(adjustments.withholdingTaxCentavos),

    // ---- derived totals ----
    netCentavos: totals.netCentavos,
    vatRate: totals.vatRate,
    vatableSalesCentavos: totals.vatableSalesCentavos,
    vatExemptSalesCentavos: totals.vatExemptSalesCentavos,
    zeroRatedSalesCentavos: totals.zeroRatedSalesCentavos,
    vatAmountCentavos: totals.vatAmountCentavos,
    grandTotalCentavos: totals.grandTotalCentavos,
    totalSalesVatInclusiveCentavos: totals.totalSalesVatInclusiveCentavos,
    totalAmountDueCentavos: totals.totalAmountDueCentavos,

    net: centavosToPesos(totals.netCentavos),
    vatableSales: centavosToPesos(totals.vatableSalesCentavos),
    vatExemptSales: centavosToPesos(totals.vatExemptSalesCentavos),
    zeroRatedSales: centavosToPesos(totals.zeroRatedSalesCentavos),
    vatAmount: centavosToPesos(totals.vatAmountCentavos),
    grandTotal: centavosToPesos(totals.grandTotalCentavos),
    totalSalesVatInclusive: centavosToPesos(totals.totalSalesVatInclusiveCentavos),
    totalAmountDue: centavosToPesos(totals.totalAmountDueCentavos),
  };
}

/**
 * Create or update the invoice draft for a server-priced order.
 *
 * The caller sends presentation text and explicit adjustments. It sends NO
 * prices, no quantities and no totals: every one of those is read from the
 * order inside this transaction. A caller that tries to send them is refused
 * with `unknown-field` rather than having them quietly dropped.
 */
async function saveInvoiceDraftForPricedOrder({ db, FieldValue, uid, payload, now }) {
  const userData = await loadUser(db, uid);
  requireRole(userData, "admin");

  const orderId = requireOrderId(payload?.orderId);
  const presentation = validatePresentation(payload?.presentation);

  const invRef = db.collection(INVOICES).doc(orderId);
  const orderRef = db.collection(ORDERS).doc(orderId);
  const year = now.getUTCFullYear();
  const counterRef = db.collection(COUNTERS).doc(`invoice_${year}`);

  return db.runTransaction(async (tx) => {
    // ---- reads ----
    const invSnap = await tx.get(invRef);
    const orderSnap = await tx.get(orderRef);
    const counterSnap = await tx.get(counterRef);

    if (!orderSnap.exists) {
      throw new PolicyError("order-not-found", "That order no longer exists.");
    }
    const order = orderSnap.data();

    const existing = invSnap.exists ? invSnap.data() : null;
    if (existing && existing.invoiceStatus === "issued") {
      throw new PolicyError(
        "invoice-already-issued",
        "This invoice has been issued and can no longer be edited."
      );
    }

    // ---- decide (throws for a legacy order — that path is the client's) ----
    const base = buildInvoiceBaseFromOrder(order);
    const adjustments = validateAdjustments(payload?.adjustments, base.subtotalCentavos);
    const totals = computeInvoiceTotalsCentavos({
      subtotalCentavos: base.subtotalCentavos,
      adjustments,
    });

    const document = buildInvoiceDocument({
      orderId, order, base, adjustments, totals, presentation,
    });

    // ---- writes ----
    if (!existing) {
      // First save reserves the number, from the same per-year counter the
      // manual path uses — never derived from a count of documents.
      const next = (counterSnap.exists ? Number(counterSnap.data().current) || 0 : 0) + 1;
      const invoiceNumber = `INV-${year}-${String(next).padStart(6, "0")}`;
      tx.set(counterRef, { current: next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      tx.set(invRef, {
        ...document,
        invoiceNumber,
        invoiceStatus: "draft",
        createdAt: FieldValue.serverTimestamp(),
        createdByUid: uid,
        updatedAt: FieldValue.serverTimestamp(),
        updatedByUid: uid,
      });
      return { invoiceId: orderId, invoiceNumber, created: true };
    }

    // A later save keeps the reserved number, the creation trail and the status.
    tx.set(
      invRef,
      {
        ...document,
        invoiceNumber: existing.invoiceNumber,
        invoiceStatus: "draft",
        createdAt: existing.createdAt ?? FieldValue.serverTimestamp(),
        createdByUid: existing.createdByUid ?? uid,
        updatedAt: FieldValue.serverTimestamp(),
        updatedByUid: uid,
      },
      { merge: false }
    );
    return { invoiceId: orderId, invoiceNumber: existing.invoiceNumber, created: false };
  });
}

/**
 * Issue the invoice for a server-priced order.
 *
 * Re-derives the base pricing from the order and refuses if the stored document
 * no longer matches it. That is what makes direct Firestore tampering between a
 * draft save and issuance a dead end: the substituted figures never become an
 * issued, legally-meaningful bill.
 */
async function issueInvoiceForPricedOrder({ db, FieldValue, uid, payload }) {
  const userData = await loadUser(db, uid);
  requireRole(userData, "admin");

  const orderId = requireOrderId(payload?.orderId);
  const invRef = db.collection(INVOICES).doc(orderId);
  const orderRef = db.collection(ORDERS).doc(orderId);

  return db.runTransaction(async (tx) => {
    const invSnap = await tx.get(invRef);
    const orderSnap = await tx.get(orderRef);

    if (!invSnap.exists) {
      throw new PolicyError("invoice-not-found", "There is no invoice draft for this order.");
    }
    if (!orderSnap.exists) {
      throw new PolicyError("order-not-found", "That order no longer exists.");
    }

    const invoice = invSnap.data();
    if (invoice.invoiceStatus === "issued") {
      // Idempotent: a retry of a call that already succeeded is not an error.
      return { invoiceId: orderId, invoiceNumber: invoice.invoiceNumber, replayed: true };
    }
    if (invoice.invoiceStatus !== "draft") {
      throw new PolicyError(
        "invalid-invoice-status",
        "Only a draft invoice can be issued."
      );
    }

    const base = buildInvoiceBaseFromOrder(orderSnap.data());
    if (!baseMatchesOrder(invoice, base)) {
      throw new PolicyError(
        "invoice-base-mismatch",
        "This invoice's prices no longer match its order. Reopen and save it before issuing."
      );
    }

    // The adjustments stored on the draft are re-validated and the totals
    // recomputed, so a total edited directly in Firestore cannot be issued.
    const adjustments = validateAdjustments(
      {
        discountCentavos: invoice.discountCentavos,
        otherChargesCentavos: invoice.otherChargesCentavos,
        withholdingTaxCentavos: invoice.withholdingTaxCentavos,
        vatClassification: invoice.vatClassification,
      },
      base.subtotalCentavos
    );
    const totals = computeInvoiceTotalsCentavos({
      subtotalCentavos: base.subtotalCentavos,
      adjustments,
    });
    if (
      invoice.grandTotalCentavos !== totals.grandTotalCentavos ||
      invoice.vatAmountCentavos !== totals.vatAmountCentavos ||
      invoice.netCentavos !== totals.netCentavos ||
      invoice.totalAmountDueCentavos !== totals.totalAmountDueCentavos
    ) {
      throw new PolicyError(
        "invoice-total-mismatch",
        "This invoice's totals do not match its own figures. Reopen and save it before issuing."
      );
    }

    tx.update(invRef, {
      invoiceStatus: "issued",
      issuedAt: FieldValue.serverTimestamp(),
      issuedByUid: uid,
      updatedAt: FieldValue.serverTimestamp(),
      updatedByUid: uid,
    });

    return { invoiceId: orderId, invoiceNumber: invoice.invoiceNumber, replayed: false };
  });
}

module.exports = {
  saveInvoiceDraftForPricedOrder,
  issueInvoiceForPricedOrder,
  buildInvoiceDocument,
};
