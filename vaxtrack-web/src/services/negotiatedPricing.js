/**
 * Negotiated prices and statutory (SC/PWD) line discounts on the Med Rep's
 * final review — pure, no Firebase.
 *
 * Per line, in integer centavos, in this order:
 *
 *   negotiated gross  = quantity × agreed unit price (VAT-inclusive)
 *   final line total  = negotiated gross − statutory discount (that line's own)
 *   line VAT          = round½↑(final line total × 12 ÷ 112) for VATable lines
 *   VAT Exempt / Zero-Rated: no VAT
 *
 * and for the order: negotiated subtotal − statutory discounts = final total
 * = VATable sales (net of VAT) + VAT + VAT-exempt sales + zero-rated sales.
 *
 * There is no total input anywhere, and a discount belongs to one line — it
 * is never an order-level amount spread across lines.
 *
 * DISPLAY ONLY. functions/src/negotiatedPricing.js is authoritative — the
 * callable re-reads every batch, re-validates every price, reason and discount
 * and computes every stored figure itself. This mirrors its arithmetic
 * (tests/negotiatedPricing.test.js pins the two together).
 */

import { centavosToInputValue, parsePesosToCentavos } from "./money.js";
import { splitVatInclusiveCentavos, VAT_RATE_PERCENT } from "./pricingConfig.js";

/** Same bound as every other reason in the system. */
export const MAX_ADJUSTMENT_REASON_LENGTH = 500;

export const NEGOTIATED_PRICE_LABEL = "Negotiated price";

/**
 * The statutory discount categories the client confirmed for per-line
 * discounts: Senior Citizen and PWD only. Only the category is collected — no
 * ID number, card photo or other personal data. Mirrors
 * STATUTORY_DISCOUNT_TYPES in functions/src/policy.js.
 */
export const STATUTORY_DISCOUNT_TYPES = Object.freeze(["senior_citizen", "pwd"]);
export const STATUTORY_DISCOUNT_LABELS = Object.freeze({
  senior_citizen: "Senior Citizen (SC)",
  pwd: "Person with Disability (PWD)",
});

/**
 * What the Med Rep confirms, per discounted line, before the order is placed.
 * It is an audited ATTESTATION by the Med Rep — the system itself does not
 * verify eligibility. Mirrors ELIGIBILITY_ATTESTATION_TEXT in
 * functions/src/policy.js.
 */
export const ELIGIBILITY_ATTESTATION_TEXT =
  "I confirm that I verified the customer’s eligibility for this statutory discount.";

function moneyMessage(reason, { emptyMessage, zeroMessage }) {
  switch (reason) {
    case "empty":
      return emptyMessage;
    case "not-positive":
      return zeroMessage;
    case "not-safe-integer":
      return "That amount is too large to record accurately.";
    default:
      return "Enter a peso amount with at most two decimal places, e.g. 1250.00.";
  }
}

/**
 * The agreed-price text a rep typed → centavos. Up to two decimal places,
 * greater than ₱0.00 (the project's price rule), exactly representable.
 */
export function parseAgreedPriceInput(text) {
  const parsed = parsePesosToCentavos(typeof text === "string" ? text : String(text ?? ""));
  if (parsed.ok) return parsed;
  return {
    ok: false,
    message: moneyMessage(parsed.reason, {
      emptyMessage: "Enter the agreed price.",
      zeroMessage: "The agreed price must be more than ₱0.00.",
    }),
  };
}

/** A discount amount the rep typed → centavos (whole centavos, more than ₱0.00). */
export function parseDiscountInput(text) {
  const parsed = parsePesosToCentavos(typeof text === "string" ? text : String(text ?? ""));
  if (parsed.ok) return parsed;
  return {
    ok: false,
    message: moneyMessage(parsed.reason, {
      emptyMessage: "Enter the discount amount.",
      zeroMessage: "The discount must be more than ₱0.00, or choose No discount.",
    }),
  };
}

/** The input text for a centavo amount ("1250.00"), e.g. for Reset to standard price. */
export function agreedInputFor(centavos) {
  return centavosToInputValue(centavos);
}

function normalizeReason(text) {
  return typeof text === "string" ? text.normalize("NFKC").trim().replace(/\s+/g, " ") : "";
}

function lineVat(final, cls) {
  if (cls === "vatable") {
    const { vatCentavos, netCentavos } = splitVatInclusiveCentavos(final);
    return { lineVatCentavos: vatCentavos, lineNetOfVatCentavos: netCentavos };
  }
  return { lineVatCentavos: 0, lineNetOfVatCentavos: final };
}

/**
 * One cart line as the final review shows it.
 *
 * [line]: quantity, expectedUnitPriceCentavos (the reviewed standard price),
 * vatClassification, and the rep's entries — `agreedInput` (absent = the
 * standard price; a cleared field is an error, never a silent reset),
 * `negotiationReason`, `discountType` ("" / absent = no discount),
 * `discountInput` and `eligibilityConfirmed` (the attestation checkbox,
 * required on a discounted line).
 */
export function priceReviewLine(line) {
  const quantity = Number.isSafeInteger(line?.quantity) && line.quantity > 0 ? line.quantity : 0;
  const standard = Number.isSafeInteger(line?.expectedUnitPriceCentavos) && line.expectedUnitPriceCentavos > 0
    ? line.expectedUnitPriceCentavos
    : null;
  const input = line?.agreedInput;
  const usesStandard = input === undefined || input === null;
  const parsed = usesStandard ? { ok: true, value: standard } : parseAgreedPriceInput(input);
  const agreed = parsed.ok ? parsed.value : null;
  let priceError = standard === null ? "This line has no standard price." : parsed.ok ? null : parsed.message;

  const standardLineTotalCentavos = standard === null ? null : quantity * standard;
  const negotiatedGrossCentavos = agreed === null ? null : quantity * agreed;
  const exact = (v) => v === null || Number.isSafeInteger(v);
  if (!exact(standardLineTotalCentavos) || !exact(negotiatedGrossCentavos)) {
    priceError = "This line's total is too large to record accurately.";
  }

  const priceNegotiated = agreed !== null && standard !== null && agreed !== standard;
  const reason = normalizeReason(line?.negotiationReason);
  let reasonError = null;
  if (priceNegotiated && reason === "") reasonError = "Give a reason for this negotiated price.";
  else if (priceNegotiated && reason.length > MAX_ADJUSTMENT_REASON_LENGTH) {
    reasonError = `Keep the reason under ${MAX_ADJUSTMENT_REASON_LENGTH} characters.`;
  }

  // The statutory discount: this line's own, against its negotiated gross.
  const discountType = typeof line?.discountType === "string" && line.discountType ? line.discountType : null;
  let statutoryDiscountCentavos = 0;
  let discountError = null;
  if (discountType !== null) {
    if (!STATUTORY_DISCOUNT_TYPES.includes(discountType)) {
      discountError = "Choose a valid discount category.";
    } else {
      const d = parseDiscountInput(line?.discountInput ?? "");
      if (!d.ok) discountError = d.message;
      else if (negotiatedGrossCentavos !== null && d.value > negotiatedGrossCentavos) {
        discountError = "The discount cannot be larger than this line's total.";
      } else statutoryDiscountCentavos = d.value;
    }
  }
  // The Med Rep's eligibility attestation — required for every discounted line.
  const eligibilityConfirmed = discountType !== null && line?.eligibilityConfirmed === true;
  const eligibilityError =
    discountType !== null && !eligibilityConfirmed
      ? "Confirm that you verified the customer's eligibility for each statutory discount."
      : null;

  const finalLineTotalCentavos =
    negotiatedGrossCentavos === null || priceError || discountError ? null : negotiatedGrossCentavos - statutoryDiscountCentavos;
  const vat = finalLineTotalCentavos === null
    ? { lineVatCentavos: null, lineNetOfVatCentavos: null }
    : lineVat(finalLineTotalCentavos, line?.vatClassification);

  return {
    standardUnitPriceCentavos: standard,
    agreedUnitPriceCentavos: agreed,
    standardLineTotalCentavos,
    negotiatedGrossCentavos,
    negotiatedAdjustmentCentavos:
      negotiatedGrossCentavos !== null && standardLineTotalCentavos !== null
        ? negotiatedGrossCentavos - standardLineTotalCentavos
        : null,
    priceNegotiated,
    negotiationReason: priceNegotiated ? reason : null,
    statutoryDiscountType: discountType !== null && !discountError ? discountType : null,
    statutoryDiscountCentavos: discountError ? 0 : statutoryDiscountCentavos,
    eligibilityConfirmed,
    finalLineTotalCentavos,
    ...vat,
    vatClassification: line?.vatClassification ?? null,
    vatRatePercent: line?.vatClassification === "vatable" ? VAT_RATE_PERCENT : 0,
    priceError,
    reasonError,
    discountError,
    eligibilityError,
  };
}

/**
 * The order's figures from its review lines. `null` (an invalid line or an
 * unknown classification) makes them unavailable rather than wrong.
 */
export function summarizeReviewVat(lines) {
  const out = {
    standardTotalCentavos: 0,
    negotiatedSubtotalCentavos: 0,
    statutoryDiscountTotalCentavos: 0,
    vatableGrossCentavos: 0,
    vatableSalesCentavos: 0,
    vatAmountCentavos: 0,
    vatExemptSalesCentavos: 0,
    zeroRatedSalesCentavos: 0,
    totalCentavos: 0,
  };
  for (const l of lines) {
    if (l.finalLineTotalCentavos === null || l.standardLineTotalCentavos === null) return null;
    out.standardTotalCentavos += l.standardLineTotalCentavos;
    out.negotiatedSubtotalCentavos += l.negotiatedGrossCentavos;
    out.statutoryDiscountTotalCentavos += l.statutoryDiscountCentavos;
    out.totalCentavos += l.finalLineTotalCentavos;
    if (l.vatClassification === "vatable") {
      out.vatableGrossCentavos += l.finalLineTotalCentavos;
      out.vatableSalesCentavos += l.lineNetOfVatCentavos;
      out.vatAmountCentavos += l.lineVatCentavos;
    } else if (l.vatClassification === "vat_exempt") out.vatExemptSalesCentavos += l.finalLineTotalCentavos;
    else if (l.vatClassification === "zero_rated") out.zeroRatedSalesCentavos += l.finalLineTotalCentavos;
    else return null;
  }
  if (!Object.values(out).every(Number.isSafeInteger)) return null;
  out.negotiatedAdjustmentCentavos = out.negotiatedSubtotalCentavos - out.standardTotalCentavos;
  return out;
}

/** Whether the review can be confirmed: every price, reason and discount valid. */
export function reviewProblems(lines) {
  const problems = [];
  lines.forEach((l) => {
    if (l.priceError) problems.push(l.priceError);
    if (l.reasonError) problems.push(l.reasonError);
    if (l.discountError) problems.push(l.discountError);
    if (l.eligibilityError) problems.push(l.eligibilityError);
  });
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}

/**
 * The per-line pricing the callable is sent: the reviewed standard, the agreed
 * unit price, the reason (negotiated lines only) and the line's statutory
 * discount (category + amount + the Med Rep's eligibility attestation,
 * discounted lines only). No totals, no VAT.
 */
export function negotiatedRequestLine(line, review) {
  return {
    expectedUnitPriceCentavos: line.expectedUnitPriceCentavos,
    agreedUnitPriceCentavos: review.agreedUnitPriceCentavos,
    ...(review.priceNegotiated ? { negotiationReason: review.negotiationReason } : {}),
    ...(review.statutoryDiscountCentavos > 0
      ? {
          statutoryDiscountType: review.statutoryDiscountType,
          statutoryDiscountCentavos: review.statutoryDiscountCentavos,
          eligibilityConfirmed: review.eligibilityConfirmed === true,
        }
      : {}),
  };
}
