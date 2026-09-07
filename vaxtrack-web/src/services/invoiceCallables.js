import { getFunctions, httpsCallable } from "firebase/functions";
import app from "../firebase";
import { InventoryCallableError } from "./inventoryCallables";

/**
 * Client side of the invoice pricing boundary.
 *
 * For an order that carries a server price snapshot, the invoice's BASE pricing
 * — item identity, quantity, unit price, line total, subtotal, currency and the
 * VAT convention — is computed on the server from the order. Firestore rules
 * refuse a direct client write to such an invoice, so these two wrappers are the
 * only way to save or issue one.
 *
 * Nothing here sends a price, a quantity or a total. It sends presentation text
 * and the admin's explicit adjustments, and the server refuses anything else.
 *
 * Orders WITHOUT a pricingVersion keep the existing manual path in
 * invoiceService.js, untouched.
 */
const FUNCTIONS_REGION = "asia-southeast1";

function callables() {
  const fns = getFunctions(app, FUNCTIONS_REGION);
  return {
    saveDraft: httpsCallable(fns, "saveInvoiceDraftForPricedOrder"),
    issue: httpsCallable(fns, "issueInvoiceForPricedOrder"),
  };
}

function rethrow(error) {
  const details = error?.details;
  if (details && typeof details.code === "string") {
    throw new InventoryCallableError(details.code, error.message, details.info);
  }
  if (error?.code === "functions/unauthenticated") {
    throw new InventoryCallableError(
      "unauthenticated",
      "Your session has expired. Please sign in again."
    );
  }
  throw new InventoryCallableError(
    "service-unavailable",
    "The invoicing service is unavailable right now. Nothing was saved — please try again.",
    null
  );
}

/**
 * Save (create or update) the draft invoice for a server-priced order.
 *
 * `adjustments` are the admin's own figures and are the ONLY money this sends:
 * a discount, other charges, withholding tax and the VAT classification. Each
 * is a separate field in centavos; none of them can restate a unit price.
 */
export async function saveInvoiceDraftForPricedOrder({ orderId, presentation, adjustments }) {
  try {
    const result = await callables().saveDraft({ orderId, presentation, adjustments });
    return result.data;
  } catch (error) {
    return rethrow(error);
  }
}

/** Issue the invoice for a server-priced order, re-checked against the order. */
export async function issueInvoiceForPricedOrder(orderId) {
  try {
    const result = await callables().issue({ orderId });
    return result.data;
  } catch (error) {
    return rethrow(error);
  }
}

/**
 * A message a user can act on, for the invoice-pricing failures specifically.
 * Everything else falls through to the sentence the server already wrote.
 */
export function messageForInvoiceError(error) {
  switch (error?.code) {
    case "order-not-priced":
      return "This order has no server price snapshot, so it is invoiced manually. Reload the page.";
    case "invoice-already-issued":
      return "This invoice has already been issued and can no longer be edited.";
    case "invoice-base-mismatch":
      return "This invoice's prices no longer match its order. Reopen it and save before issuing.";
    case "invoice-total-mismatch":
      return "This invoice's totals do not match its own figures. Save it again before issuing.";
    case "discount-exceeds-subtotal":
      return "The discount is larger than the invoice subtotal. Lower it and try again.";
    case "order-snapshot-invalid":
      return "This order's recorded prices are inconsistent and need admin review before invoicing.";
    default:
      return error?.message || "Unable to save the invoice. Please try again.";
  }
}
