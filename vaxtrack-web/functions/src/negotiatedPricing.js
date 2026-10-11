"use strict";

/**
 * Negotiated (agreed) order pricing — pure, no Firestore.
 *
 * Business rule: the Med Rep negotiates and confirms each line's FINAL price
 * before the order is placed. There is no separate approver. After placement
 * the price is an immutable snapshot on the order; nothing edits it.
 *
 * WHAT THE CLIENT MAY SEND, per line: the standard price it reviewed
 * (`expectedUnitPriceCentavos`, checked against the batch), the agreed
 * VAT-inclusive UNIT price (`agreedUnitPriceCentavos`) and, when that differs
 * from the standard, a reason. Never a total, a VAT figure or a
 * classification: every one of those is computed here from integers.
 *
 * Money is integer PHP centavos throughout. The only rounding is the VAT
 * extraction, done ONCE on the aggregated VATable amount by
 * splitVatInclusiveCentavos (round half up of gross × 12 ÷ 112) — the rule the
 * invoice and the receipt already use — so every figure below reconciles to
 * the centavo:
 *
 *   line total        = quantity × agreed unit price
 *   order total       = Σ line totals
 *   VAT amount        = round½↑(VATable gross × 12 ÷ 112)
 *   VATable sales     = VATable gross − VAT amount          (net of VAT)
 *   VAT-exempt sales  = Σ VAT-exempt line totals            (no VAT)
 *   zero-rated sales  = Σ zero-rated line totals            (no VAT)
 *   order total       = VATable sales + VAT amount + VAT-exempt + zero-rated
 */

const {
  PolicyError,
  PRODUCT_VAT_CLASSIFICATIONS,
  normalizeAdjustmentReason,
  MAX_ADJUSTMENT_REASON_LENGTH,
} = require("./policy");
const { VAT_RATE_PERCENT, splitVatInclusiveCentavos } = require("./pricingConfig");

/** Stamped on every order whose lines carry standard + agreed prices. */
const PRICE_AGREEMENT_VERSION = 1;

const isMoney = (v) => typeof v === "number" && Number.isSafeInteger(v);

/**
 * One line, priced. [standardUnitPriceCentavos] is the batch's price read in
 * the transaction; [agreedUnitPriceCentavos] and [adjustmentReason] are the
 * Med Rep's (already shape-checked by validateCreatePayload). A line whose
 * agreed price equals the standard carries no adjustment and no reason.
 */
function priceOrderLine({ quantity, standardUnitPriceCentavos, agreedUnitPriceCentavos, adjustmentReason, vatClassification }) {
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
  const agreedLineTotalCentavos = quantity * agreed;
  if (!Number.isSafeInteger(standardLineTotalCentavos) || !Number.isSafeInteger(agreedLineTotalCentavos)) {
    throw new PolicyError("line-total-out-of-range", "This line's total is too large to record accurately.");
  }
  const priceAdjusted = agreed !== standardUnitPriceCentavos;
  const reason = priceAdjusted ? normalizeAdjustmentReason(adjustmentReason) : null;

  return {
    standardUnitPriceCentavos,
    agreedUnitPriceCentavos: agreed,
    standardLineTotalCentavos,
    agreedLineTotalCentavos,
    // Signed: negative when the agreed price is below the standard.
    adjustmentCentavos: agreedLineTotalCentavos - standardLineTotalCentavos,
    priceAdjusted,
    adjustmentReason: reason,
    vatClassification,
    vatRatePercent: vatClassification === "vatable" ? VAT_RATE_PERCENT : 0,
    // The fields every existing reader uses — invoice, receipt, confirmation,
    // analytics — are the price actually CHARGED: the agreed one.
    unitPriceCentavos: agreed,
    lineTotalCentavos: agreedLineTotalCentavos,
  };
}

/**
 * The order's VAT breakdown from its priced lines (VAT-inclusive prices).
 * One rounding, on the aggregated VATable gross; the parts always sum to the
 * total exactly.
 */
function summarizeOrderVat(lines) {
  let vatableGrossCentavos = 0;
  let vatExemptSalesCentavos = 0;
  let zeroRatedSalesCentavos = 0;
  for (const line of lines) {
    const amount = line.agreedLineTotalCentavos ?? line.lineTotalCentavos;
    if (!isMoney(amount) || amount < 0) {
      throw new PolicyError("order-total-out-of-range", "This order's total is too large to record accurately.");
    }
    if (line.vatClassification === "vatable") vatableGrossCentavos += amount;
    else if (line.vatClassification === "vat_exempt") vatExemptSalesCentavos += amount;
    else if (line.vatClassification === "zero_rated") zeroRatedSalesCentavos += amount;
    else {
      throw new PolicyError(
        "vat-classification-required",
        "This vaccine must be classified as VAT, VAT Exempt or Zero-Rated before ordering."
      );
    }
  }
  const totalCentavos = vatableGrossCentavos + vatExemptSalesCentavos + zeroRatedSalesCentavos;
  if (!Number.isSafeInteger(totalCentavos)) {
    throw new PolicyError("order-total-out-of-range", "This order's total is too large to record accurately.");
  }
  const { vatCentavos, netCentavos } = splitVatInclusiveCentavos(vatableGrossCentavos);
  return {
    vatRatePercent: VAT_RATE_PERCENT,
    vatableGrossCentavos,
    vatableSalesCentavos: netCentavos,
    vatAmountCentavos: vatCentavos,
    vatExemptSalesCentavos,
    zeroRatedSalesCentavos,
    totalCentavos,
  };
}

/** Order-level figures over the priced lines. */
function summarizeAgreement(lines) {
  const sum = (key) => lines.reduce((total, line) => total + line[key], 0);
  const standardSubtotalCentavos = sum("standardLineTotalCentavos");
  const subtotalCentavos = sum("agreedLineTotalCentavos");
  if (!Number.isSafeInteger(standardSubtotalCentavos) || !Number.isSafeInteger(subtotalCentavos)) {
    throw new PolicyError("order-total-out-of-range", "This order's total is too large to record accurately.");
  }
  return {
    priceAgreementVersion: PRICE_AGREEMENT_VERSION,
    standardSubtotalCentavos,
    subtotalCentavos,
    priceAdjustmentCentavos: subtotalCentavos - standardSubtotalCentavos,
    priceAdjusted: lines.some((line) => line.priceAdjusted),
    vatSummary: summarizeOrderVat(lines),
  };
}

/** The immutable audit record for one adjusted line. Actor and time are the server's. */
function priceAdjustmentAuditRecord({ orderId, orderNumber, lineIndex, line, uid, requestId, FieldValue }) {
  return {
    orderId,
    orderNumber,
    lineIndex,
    inventoryId: line.inventoryId ?? null,
    batchId: line.batchId ?? null,
    productKey: line.productKey ?? null,
    sku: line.sku ?? null,
    name: line.name ?? null,
    quantity: line.quantity,
    standardUnitPriceCentavos: line.standardUnitPriceCentavos,
    agreedUnitPriceCentavos: line.agreedUnitPriceCentavos,
    standardLineTotalCentavos: line.standardLineTotalCentavos,
    agreedLineTotalCentavos: line.agreedLineTotalCentavos,
    adjustmentCentavos: line.adjustmentCentavos,
    adjustmentReason: line.adjustmentReason,
    vatClassification: line.vatClassification,
    priceCurrency: "PHP",
    priceIsVatInclusive: true,
    medRepUid: uid,
    requestId,
    createdAt: FieldValue.serverTimestamp(),
  };
}

/** The audit document id for one adjusted line — deterministic, so a retry cannot duplicate it. */
function priceAdjustmentAuditId(orderId, lineIndex) {
  return `${orderId}__${lineIndex}`;
}

/**
 * An order that records negotiated pricing. Detected by its version stamp
 * only; an older order is read as "every line at its standard price".
 */
function hasPriceAgreement(order) {
  return order?.priceAgreementVersion === PRICE_AGREEMENT_VERSION;
}

/** True when any line of [order] was negotiated away from its standard price. */
function orderHasNegotiatedPrice(order) {
  if (!hasPriceAgreement(order)) return false;
  if (order.priceAdjusted === true) return true;
  return (Array.isArray(order.items) ? order.items : []).some((i) => i?.priceAdjusted === true);
}

module.exports = {
  PRICE_AGREEMENT_VERSION,
  MAX_ADJUSTMENT_REASON_LENGTH,
  priceOrderLine,
  normalizeAdjustmentReason,
  summarizeOrderVat,
  summarizeAgreement,
  priceAdjustmentAuditRecord,
  priceAdjustmentAuditId,
  hasPriceAgreement,
  orderHasNegotiatedPrice,
};
