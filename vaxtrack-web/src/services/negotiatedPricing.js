/**
 * Negotiated (agreed) pricing on the Med Rep's final review — pure, no Firebase.
 *
 * The Med Rep may change each line's VAT-INCLUSIVE AGREED UNIT PRICE before the
 * order is placed. Everything else is derived, in integer centavos:
 *
 *   line total   = quantity × agreed unit price
 *   order total  = Σ line totals
 *   VAT          = round½↑(VATable gross × 12 ÷ 112)  — once, on the aggregate
 *   VATable sales (net of VAT) = VATable gross − VAT
 *   VAT-exempt / zero-rated sales = their line totals (no VAT)
 *
 * There is no total input anywhere: a mixed order is negotiated line by line,
 * never by spreading an arbitrary total across VAT classes.
 *
 * DISPLAY ONLY. functions/src/negotiatedPricing.js is authoritative — the
 * callable re-reads every batch, re-validates every agreed price and reason,
 * and computes every stored figure itself. This module mirrors its arithmetic
 * (tests/negotiatedPricing.test.js pins the two together) so the rep sees what
 * will be recorded.
 */

import { centavosToInputValue, parsePesosToCentavos } from "./money.js";
import { splitVatInclusiveCentavos, VAT_RATE_PERCENT } from "./pricingConfig.js";

/** Same bound as every other reason in the system. */
export const MAX_ADJUSTMENT_REASON_LENGTH = 500;

export const NEGOTIATED_PRICE_LABEL = "Negotiated price";

/**
 * The agreed-price text a rep typed → centavos. Up to two decimal places,
 * greater than ₱0.00 (the project's price rule), exactly representable.
 * Returns { ok, value } or { ok: false, message }.
 */
export function parseAgreedPriceInput(text) {
  const parsed = parsePesosToCentavos(typeof text === "string" ? text : String(text ?? ""));
  if (parsed.ok) return parsed;
  switch (parsed.reason) {
    case "empty":
      return { ok: false, message: "Enter the agreed price." };
    case "not-positive":
      return { ok: false, message: "The agreed price must be more than ₱0.00." };
    case "not-safe-integer":
      return { ok: false, message: "That price is too large to record accurately." };
    default:
      return { ok: false, message: "Enter a peso amount with at most two decimal places, e.g. 1250.00." };
  }
}

/** The input text for a centavo amount ("1250.00"), e.g. for Reset to standard price. */
export function agreedInputFor(centavos) {
  return centavosToInputValue(centavos);
}

function normalizeReason(text) {
  return typeof text === "string" ? text.normalize("NFKC").trim().replace(/\s+/g, " ") : "";
}

/**
 * One cart line as the final review shows it.
 *
 * [line] carries quantity, expectedUnitPriceCentavos (the reviewed standard
 * price), vatClassification, and the rep's `agreedInput` text and
 * `adjustmentReason` text. An UNTOUCHED field (agreedInput absent) is the
 * standard price; a field the rep cleared is an error, never a silent reset.
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
  const priceError = standard === null ? "This line has no standard price." : parsed.ok ? null : parsed.message;

  const standardLineTotalCentavos = standard === null ? null : quantity * standard;
  const agreedLineTotalCentavos = agreed === null ? null : quantity * agreed;
  const exact = (v) => v === null || Number.isSafeInteger(v);
  const overflow = !exact(standardLineTotalCentavos) || !exact(agreedLineTotalCentavos);

  const priceAdjusted = agreed !== null && standard !== null && agreed !== standard;
  const reason = normalizeReason(line?.adjustmentReason);
  let reasonError = null;
  if (priceAdjusted && reason === "") reasonError = "Give a reason for this negotiated price.";
  else if (priceAdjusted && reason.length > MAX_ADJUSTMENT_REASON_LENGTH) {
    reasonError = `Keep the reason under ${MAX_ADJUSTMENT_REASON_LENGTH} characters.`;
  }

  return {
    standardUnitPriceCentavos: standard,
    agreedUnitPriceCentavos: agreed,
    standardLineTotalCentavos,
    agreedLineTotalCentavos,
    adjustmentCentavos:
      agreedLineTotalCentavos !== null && standardLineTotalCentavos !== null
        ? agreedLineTotalCentavos - standardLineTotalCentavos
        : null,
    priceAdjusted,
    adjustmentReason: priceAdjusted ? reason : null,
    vatClassification: line?.vatClassification ?? null,
    vatRatePercent: line?.vatClassification === "vatable" ? VAT_RATE_PERCENT : 0,
    priceError: overflow ? "This line's total is too large to record accurately." : priceError,
    reasonError,
  };
}

/**
 * The VAT breakdown of the agreed totals. `null` amounts (an invalid line or
 * an unknown classification) make the breakdown unavailable rather than wrong.
 */
export function summarizeReviewVat(lines) {
  let vatable = 0;
  let exempt = 0;
  let zero = 0;
  let standard = 0;
  for (const l of lines) {
    if (l.agreedLineTotalCentavos === null || l.standardLineTotalCentavos === null) return null;
    standard += l.standardLineTotalCentavos;
    if (l.vatClassification === "vatable") vatable += l.agreedLineTotalCentavos;
    else if (l.vatClassification === "vat_exempt") exempt += l.agreedLineTotalCentavos;
    else if (l.vatClassification === "zero_rated") zero += l.agreedLineTotalCentavos;
    else return null;
  }
  const total = vatable + exempt + zero;
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(standard)) return null;
  const { vatCentavos, netCentavos } = splitVatInclusiveCentavos(vatable);
  return {
    vatableGrossCentavos: vatable,
    vatableSalesCentavos: netCentavos,
    vatAmountCentavos: vatCentavos,
    vatExemptSalesCentavos: exempt,
    zeroRatedSalesCentavos: zero,
    totalCentavos: total,
    standardTotalCentavos: standard,
    adjustmentCentavos: total - standard,
  };
}

/**
 * Whether the review can be confirmed: every agreed price valid and every
 * negotiated line explained. Returns { ok, problems: [message] }.
 */
export function reviewProblems(lines) {
  const problems = [];
  lines.forEach((l) => {
    if (l.priceError) problems.push(l.priceError);
    if (l.reasonError) problems.push(l.reasonError);
  });
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}

/**
 * The per-line pricing the callable is sent: the reviewed standard, the agreed
 * unit price and, only for a negotiated line, its reason. No totals, no VAT.
 */
export function negotiatedRequestLine(line, review) {
  return {
    expectedUnitPriceCentavos: line.expectedUnitPriceCentavos,
    agreedUnitPriceCentavos: review.agreedUnitPriceCentavos,
    ...(review.priceAdjusted ? { adjustmentReason: review.adjustmentReason } : {}),
  };
}
