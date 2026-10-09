"use strict";

/**
 * Evidence a delivery must carry before the server will complete it.
 *
 * The Rider app now completes a delivery in the same action that submits its
 * proof, so "both photos are recorded" is no longer a screen-side courtesy —
 * markOrderDeliveredWithInventoryConsumption checks it here, against the order
 * as the transaction read it.
 *
 * The authoritative evidence model is the order's own metadata, written by the
 * rider's proof/invoice submissions and validated by firestore.rules
 * (isValidProofSubmission / isValidInvoiceSubmission):
 *
 *   proofSubmittedAt   (server time, one-shot)   invoiceSubmittedAt
 *   proofSubmittedByUid (the session that wrote)  invoiceSubmittedByUid
 *   proofOfDeliveryUrl                            invoiceUrl
 *   proofOfDeliveryPath (canonical object)        invoicePath
 *   proofRecipientName
 *
 * A Storage object on its own is NOT evidence. A file can exist at the
 * canonical path with no metadata (an upload whose save failed), and legacy
 * orders may carry only a bare URL from the removed manual-link fallback with
 * no path. Neither completes a delivery: the evidence has to be recorded.
 *
 * Pure — no Firebase import — so it is unit-tested directly.
 */

const PROOF_FILE = "proof.jpg";
const INVOICE_FILE = "invoice.jpg";

/** Must match canonicalProofPath()/canonicalInvoicePath() in firestore.rules
 * and proofObjectPath()/invoiceObjectPath() in the Rider app. */
const canonicalProofPath = (orderId) => `proof_of_delivery/${orderId}/${PROOF_FILE}`;
const canonicalInvoicePath = (orderId) => `invoices/${orderId}/${INVOICE_FILE}`;

const text = (v) => typeof v === "string" && v.trim() !== "";
const present = (v) => v !== undefined && v !== null && v !== "";

const MESSAGES = Object.freeze({
  "proof-missing":
    "The proof-of-delivery photo is not recorded for this delivery yet. Submit it, then complete the delivery.",
  "invoice-missing":
    "The invoice photo is not recorded for this delivery yet. Submit it, then complete the delivery.",
  "evidence-not-yours":
    "This delivery's evidence was recorded by a different rider. Ask your dispatcher to review it.",
});

/**
 * Why [order] may not be completed by [uid] yet, or null when its evidence is
 * complete. Checked proof first, then invoice, so the rider is told the first
 * missing step.
 */
function deliveryEvidenceProblem(order, orderId, uid) {
  const proofRecorded =
    present(order?.proofSubmittedAt) &&
    text(order?.proofOfDeliveryUrl) &&
    text(order?.proofRecipientName) &&
    order?.proofOfDeliveryPath === canonicalProofPath(orderId) &&
    text(order?.proofSubmittedByUid);
  if (!proofRecorded) return { code: "proof-missing", message: MESSAGES["proof-missing"] };

  const invoiceRecorded =
    present(order?.invoiceSubmittedAt) &&
    text(order?.invoiceUrl) &&
    order?.invoicePath === canonicalInvoicePath(orderId) &&
    text(order?.invoiceSubmittedByUid);
  if (!invoiceRecorded) return { code: "invoice-missing", message: MESSAGES["invoice-missing"] };

  // The completing rider must be the one who recorded the evidence: a rider
  // assigned after another rider proved the delivery cannot complete it on
  // the strength of someone else's photos.
  if (order.proofSubmittedByUid !== uid || order.invoiceSubmittedByUid !== uid) {
    return { code: "evidence-not-yours", message: MESSAGES["evidence-not-yours"] };
  }
  return null;
}

module.exports = {
  canonicalProofPath,
  canonicalInvoicePath,
  deliveryEvidenceProblem,
  DELIVERY_EVIDENCE_MESSAGES: MESSAGES,
};
