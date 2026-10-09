/**
 * Product VAT classification — pure, no Firebase import (runs under node --test).
 *
 * The client decision: VAT classification belongs to each ORDER ITEM. It is set
 * on the vaccine catalog document (`vaccines/{id}.vatClassification`) by an
 * Admin, and copied onto every order item by the trusted order-creation
 * function as an immutable snapshot. Changing a product later affects only
 * future order items — never an existing order or invoice.
 *
 * Stored values are exactly `vatable` or `vat_exempt`. There is no default: a
 * product without one is "Not classified" and cannot be ordered until an Admin
 * classifies it. An order item without a snapshot (created before this) is
 * "Not recorded" — it is never inferred from the product's current value.
 *
 * functions/src/policy.js carries the same two values for the server.
 */

export const PRODUCT_VAT_CLASSIFICATIONS = Object.freeze(["vatable", "vat_exempt"]);

export const PRODUCT_VAT_LABELS = Object.freeze({
  vatable: "VAT",
  vat_exempt: "VAT Exempt",
});

export const NOT_CLASSIFIED = "Not classified";
export const NOT_RECORDED = "Not recorded";

export const VAT_REQUIRED_TO_ORDER_MESSAGE =
  "This vaccine needs a VAT classification before it can be ordered.";

/** The canonical value, or null for anything else (absent, legacy, unknown). */
export function readVatClassification(value) {
  return PRODUCT_VAT_CLASSIFICATIONS.includes(value) ? value : null;
}

/** "VAT" / "VAT Exempt" for a vaccine product, else "Not classified". */
export function productVatLabel(vaccine) {
  const cls = readVatClassification(vaccine?.vatClassification);
  return cls ? PRODUCT_VAT_LABELS[cls] : NOT_CLASSIFIED;
}

/** "VAT" / "VAT Exempt" for an order or invoice item's snapshot, else "Not recorded". */
export function itemVatLabel(item) {
  const cls = readVatClassification(item?.vatClassification);
  return cls ? PRODUCT_VAT_LABELS[cls] : NOT_RECORDED;
}

/**
 * The classification an inventory batch inherits from its vaccine product.
 * A batch with no `vaccineId`, or whose vaccine is missing or unclassified,
 * resolves to null — and cannot be ordered.
 */
export function batchVatClassification(batch, vaccinesById) {
  const vaccineId = typeof batch?.vaccineId === "string" ? batch.vaccineId : "";
  if (!vaccineId) return null;
  const vaccine = vaccinesById instanceof Map ? vaccinesById.get(vaccineId) : vaccinesById?.[vaccineId];
  return readVatClassification(vaccine?.vatClassification);
}

/**
 * Layer a vaccine product's classification onto a Med Rep catalog card
 * (Request Order). An unclassified or unlinked batch stays VISIBLE but cannot
 * be ordered, with the agreed reason; an existing, more specific block
 * (expired, unpriced, …) keeps its own reason. The server refuses the same
 * batch with vat-classification-required, so this is the fast UI copy.
 */
export function applyVatToCatalogProduct(product, vaccinesById) {
  const cls = batchVatClassification(product, vaccinesById);
  if (cls) return { ...product, vatClassification: cls, vatLabel: PRODUCT_VAT_LABELS[cls] };
  if (!product.orderable) return { ...product, vatClassification: null, vatLabel: NOT_CLASSIFIED };
  const reason = VAT_REQUIRED_TO_ORDER_MESSAGE.replace(/\.$/, "");
  return {
    ...product,
    vatClassification: null,
    vatLabel: NOT_CLASSIFIED,
    orderable: false,
    blockedReason: reason,
    blockedReasonCode: "vat-classification-required",
    status: reason,
  };
}
