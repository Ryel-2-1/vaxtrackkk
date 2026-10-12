"use strict";

/**
 * Negotiated pricing and statutory (SC/PWD) line discounts — pure, no Firestore.
 *
 * Business rules (confirmed):
 *   - The Med Rep negotiates and confirms each line's VAT-inclusive AGREED unit
 *     price before the order is placed. No separate approver. After placement
 *     the price is an immutable snapshot.
 *   - A line may ALSO carry a fixed statutory discount (SC/PWD, and the other
 *     categories the invoice names), entered separately for that line. It is
 *     never an order-level amount and never distributed across lines.
 *
 * WHAT THE CLIENT MAY SEND, per line: the standard price it reviewed, the agreed
 * unit price (+ reason when it differs), and a discount category + amount.
 * Never a total, a VAT figure or a classification.
 *
 * Every figure is integer PHP centavos. Per line, in this order:
 *
 *   negotiated gross   = quantity × agreed unit price
 *   final line total   = negotiated gross − statutory discount
 *   line VAT (VATable) = round½↑(final line total × 12 ÷ 112)   (extracted)
 *   line net of VAT    = final line total − line VAT
 *   VAT Exempt / Zero-Rated: line VAT = 0, net = final line total
 *
 * and for the order (sums of the lines, so everything reconciles exactly):
 *
 *   negotiated subtotal − statutory discounts = final total
 *   final total = VATable sales (net) + VAT + VAT-exempt sales + zero-rated sales
 *
 * VAT is rounded PER LINE, after that line's discount, as specified — the order
 * VAT is the sum of the line VATs. (Orders placed before this model keep the
 * single aggregate rounding they were invoiced with.)
 */

const {
  PolicyError,
  PRODUCT_VAT_CLASSIFICATIONS,
  normalizeNegotiationReason,
  validateStatutoryDiscount,
  MAX_ADJUSTMENT_REASON_LENGTH,
  STATUTORY_DISCOUNT_TYPES,
  ELIGIBILITY_ATTESTATION_TEXT,
} = require("./policy");
const { VAT_RATE_PERCENT, splitVatInclusiveCentavos } = require("./pricingConfig");

/** Stamped on every order priced under this model (per-line prices, discounts and VAT). */
const PRICE_AGREEMENT_VERSION = 1;

const isMoney = (v) => typeof v === "number" && Number.isSafeInteger(v);

/** A line's VAT on its final (post-discount) VAT-inclusive total. */
function lineVat(finalLineTotalCentavos, vatClassification) {
  if (vatClassification === "vatable") {
    const { vatCentavos, netCentavos } = splitVatInclusiveCentavos(finalLineTotalCentavos);
    return { lineVatCentavos: vatCentavos, lineNetOfVatCentavos: netCentavos };
  }
  return { lineVatCentavos: 0, lineNetOfVatCentavos: finalLineTotalCentavos };
}

/**
 * One line, priced. [standardUnitPriceCentavos] is the batch's price read in
 * the transaction; everything else is the Med Rep's (already shape-checked by
 * validateCreatePayload and re-checked here).
 */
function priceOrderLine({
  quantity,
  standardUnitPriceCentavos,
  agreedUnitPriceCentavos,
  negotiationReason,
  statutoryDiscountType,
  statutoryDiscountCentavos,
  eligibilityConfirmed,
  vatClassification,
}) {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new PolicyError("invalid-quantity", "Quantity must be a whole number greater than zero.");
  }
  if (!isMoney(standardUnitPriceCentavos) || standardUnitPriceCentavos <= 0) {
    throw new PolicyError("batch-unpriced", "This batch's selling price is not a valid amount and needs admin review.");
  }
  const agreed = agreedUnitPriceCentavos ?? standardUnitPriceCentavos;
  if (!isMoney(agreed) || agreed <= 0) {
    throw new PolicyError("invalid-agreed-price", "An agreed price must be an amount greater than ₱0.00.");
  }
  if (!PRODUCT_VAT_CLASSIFICATIONS.includes(vatClassification)) {
    throw new PolicyError(
      "vat-classification-required",
      "This vaccine must be classified as VAT, VAT Exempt or Zero-Rated before ordering."
    );
  }

  const standardLineTotalCentavos = quantity * standardUnitPriceCentavos;
  const negotiatedGrossCentavos = quantity * agreed;
  if (!Number.isSafeInteger(standardLineTotalCentavos) || !Number.isSafeInteger(negotiatedGrossCentavos)) {
    throw new PolicyError("line-total-out-of-range", "This line's total is too large to record accurately.");
  }
  const priceNegotiated = agreed !== standardUnitPriceCentavos;
  const reason = priceNegotiated ? normalizeNegotiationReason(negotiationReason) : null;

  const discount = validateStatutoryDiscount({
    type: statutoryDiscountType,
    centavos: statutoryDiscountCentavos === 0 && (statutoryDiscountType ?? null) === null ? null : statutoryDiscountCentavos,
    negotiatedGrossCentavos,
    eligibilityConfirmed,
  });
  const finalLineTotalCentavos = negotiatedGrossCentavos - discount.centavos;
  const vat = lineVat(finalLineTotalCentavos, vatClassification);

  return {
    standardUnitPriceCentavos,
    standardLineTotalCentavos,
    agreedUnitPriceCentavos: agreed,
    negotiatedGrossCentavos,
    // The negotiated price change, kept apart from any statutory discount.
    // Signed: negative when the agreed price is below the standard.
    negotiatedAdjustmentCentavos: negotiatedGrossCentavos - standardLineTotalCentavos,
    priceNegotiated,
    negotiationReason: reason,
    // The statutory discount, kept apart from the negotiated adjustment.
    statutoryDiscountType: discount.type,
    statutoryDiscountCentavos: discount.centavos,
    // The Med Rep's eligibility attestation (true only on a discounted line).
    // An attestation, not a verification: the system checks no eligibility data.
    eligibilityConfirmed: discount.eligibilityConfirmed,
    // What this line is charged, and its authoritative VAT breakdown.
    finalLineTotalCentavos,
    vatClassification,
    vatRatePercent: vatClassification === "vatable" ? VAT_RATE_PERCENT : 0,
    lineVatCentavos: vat.lineVatCentavos,
    lineNetOfVatCentavos: vat.lineNetOfVatCentavos,
    // The fields every existing reader multiplies and sums: the agreed unit
    // price and the negotiated gross (quantity × unit price). The statutory
    // discount is the separate, named reduction above.
    unitPriceCentavos: agreed,
    lineTotalCentavos: negotiatedGrossCentavos,
  };
}

/** Order-level figures — sums of the priced lines, reconciling to the centavo. */
function summarizeAgreement(lines) {
  const sum = (key) => lines.reduce((total, line) => total + line[key], 0);
  const standardSubtotalCentavos = sum("standardLineTotalCentavos");
  const negotiatedSubtotalCentavos = sum("negotiatedGrossCentavos");
  const statutoryDiscountTotalCentavos = sum("statutoryDiscountCentavos");
  const finalTotalCentavos = sum("finalLineTotalCentavos");
  let vatableGrossCentavos = 0;
  let vatableSalesCentavos = 0;
  let vatAmountCentavos = 0;
  let vatExemptSalesCentavos = 0;
  let zeroRatedSalesCentavos = 0;
  for (const line of lines) {
    if (line.vatClassification === "vatable") {
      vatableGrossCentavos += line.finalLineTotalCentavos;
      vatableSalesCentavos += line.lineNetOfVatCentavos;
      vatAmountCentavos += line.lineVatCentavos;
    } else if (line.vatClassification === "vat_exempt") {
      vatExemptSalesCentavos += line.finalLineTotalCentavos;
    } else {
      zeroRatedSalesCentavos += line.finalLineTotalCentavos;
    }
  }
  for (const v of [standardSubtotalCentavos, negotiatedSubtotalCentavos, finalTotalCentavos]) {
    if (!Number.isSafeInteger(v)) {
      throw new PolicyError("order-total-out-of-range", "This order's total is too large to record accurately.");
    }
  }
  if (negotiatedSubtotalCentavos - statutoryDiscountTotalCentavos !== finalTotalCentavos) {
    // Cannot happen by construction; refuse rather than record a figure that does not add up.
    throw new PolicyError("order-total-out-of-range", "This order's totals do not reconcile.");
  }
  return {
    priceAgreementVersion: PRICE_AGREEMENT_VERSION,
    standardSubtotalCentavos,
    negotiatedSubtotalCentavos,
    negotiatedAdjustmentTotalCentavos: negotiatedSubtotalCentavos - standardSubtotalCentavos,
    priceNegotiated: lines.some((line) => line.priceNegotiated),
    statutoryDiscountTotalCentavos,
    statutoryDiscountApplied: statutoryDiscountTotalCentavos > 0,
    finalTotalCentavos,
    // After discounts; VAT is the sum of the per-line VAT.
    vatSummary: {
      vatRatePercent: VAT_RATE_PERCENT,
      vatableGrossCentavos,
      vatableSalesCentavos,
      vatAmountCentavos,
      vatExemptSalesCentavos,
      zeroRatedSalesCentavos,
      totalCentavos: finalTotalCentavos,
    },
  };
}

function lineIdentity(line) {
  return {
    inventoryId: line.inventoryId ?? null,
    batchId: line.batchId ?? null,
    productKey: line.productKey ?? null,
    sku: line.sku ?? null,
    name: line.name ?? null,
    quantity: line.quantity,
  };
}

/**
 * The immutable NEGOTIATED-PRICE audit record for one line whose agreed price
 * differs from the standard. Actor and time are the server's.
 */
function priceAdjustmentAuditRecord({ orderId, orderNumber, lineIndex, line, uid, requestId, FieldValue }) {
  return {
    orderId,
    orderNumber,
    lineIndex,
    ...lineIdentity(line),
    standardUnitPriceCentavos: line.standardUnitPriceCentavos,
    agreedUnitPriceCentavos: line.agreedUnitPriceCentavos,
    standardLineTotalCentavos: line.standardLineTotalCentavos,
    negotiatedGrossCentavos: line.negotiatedGrossCentavos,
    negotiatedAdjustmentCentavos: line.negotiatedAdjustmentCentavos,
    negotiationReason: line.negotiationReason,
    vatClassification: line.vatClassification,
    priceCurrency: "PHP",
    priceIsVatInclusive: true,
    medRepUid: uid,
    requestId,
    createdAt: FieldValue.serverTimestamp(),
  };
}

/**
 * The immutable STATUTORY-DISCOUNT audit record for one discounted line —
 * a separate record in a separate collection, never merged with the
 * negotiated-price audit. Only the category is recorded: no ID number, card
 * photo, name or other personal data of the beneficiary.
 *
 * It carries the Med Rep's ELIGIBILITY ATTESTATION: the exact statement they
 * confirmed, that it was confirmed, by whom (the verified uid) and when (server
 * time). This records a person's attestation; it is NOT automatic eligibility
 * verification — the system holds no eligibility data to check.
 */
function statutoryDiscountAuditRecord({ orderId, orderNumber, lineIndex, line, uid, requestId, FieldValue }) {
  return {
    orderId,
    orderNumber,
    lineIndex,
    ...lineIdentity(line),
    discountType: line.statutoryDiscountType,
    discountCentavos: line.statutoryDiscountCentavos,
    negotiatedGrossCentavos: line.negotiatedGrossCentavos,
    finalLineTotalCentavos: line.finalLineTotalCentavos,
    vatClassification: line.vatClassification,
    lineVatCentavos: line.lineVatCentavos,
    priceCurrency: "PHP",
    priceIsVatInclusive: true,
    eligibilityConfirmed: line.eligibilityConfirmed === true,
    eligibilityVerificationMethod: "med_rep_attestation",
    eligibilityAttestationText: ELIGIBILITY_ATTESTATION_TEXT,
    eligibilityConfirmedByUid: uid,
    eligibilityConfirmedAt: FieldValue.serverTimestamp(),
    medRepUid: uid,
    requestId,
    createdAt: FieldValue.serverTimestamp(),
  };
}

/** Audit document id for one line — deterministic, so a retry cannot duplicate it. */
function priceAdjustmentAuditId(orderId, lineIndex) {
  return `${orderId}__${lineIndex}`;
}
const statutoryDiscountAuditId = priceAdjustmentAuditId;

/** An order priced under this model. Detected by its version stamp only. */
function hasPriceAgreement(order) {
  return order?.priceAgreementVersion === PRICE_AGREEMENT_VERSION;
}

module.exports = {
  PRICE_AGREEMENT_VERSION,
  MAX_ADJUSTMENT_REASON_LENGTH,
  STATUTORY_DISCOUNT_TYPES,
  ELIGIBILITY_ATTESTATION_TEXT,
  priceOrderLine,
  lineVat,
  summarizeAgreement,
  priceAdjustmentAuditRecord,
  statutoryDiscountAuditRecord,
  priceAdjustmentAuditId,
  statutoryDiscountAuditId,
  hasPriceAgreement,
};
