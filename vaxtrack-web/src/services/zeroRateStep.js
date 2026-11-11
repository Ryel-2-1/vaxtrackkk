/**
 * The checkout's zero-rating step (2026-11-11). Before pricing, a Med Rep must
 * answer "Is this a zero-rated sale?" for any order with VATable items:
 *
 *   No  → standard VAT; pricing and Finalize open.
 *   Yes → a request goes to Admin; pricing waits for the decision. Approval
 *         removes the VAT from the VATable lines (vatQuote.js); denial means
 *         request again or choose No.
 *
 * An order with no VATable items has nothing to zero-rate and skips the step.
 * A saved checkout being recovered resumes as it was sent (recovering).
 * This is the checkout's process; the server still decides what is
 * zero-rated, only from an exact approved request (zeroRateOrderMatch.js).
 */

export const ZERO_RATE_STEP = Object.freeze({
  NOT_NEEDED: "not_needed",
  UNANSWERED: "unanswered",
  STANDARD: "standard",
  REQUESTING: "requesting",
  DENIED: "denied",
  PENDING: "pending",
  APPROVED: "approved",
});

/**
 * @param {object} p
 * @param {boolean} p.hasVatable   the cart has a VATable product
 * @param {boolean} p.approved     an exact approved request applies
 * @param {boolean} p.pending      an exact request is waiting for Admin
 * @param {boolean} p.denied       the latest exact request was denied
 * @param {""|"no"|"yes"} p.answer the rep's answer this session
 * @param {boolean} [p.recovering] a saved attempt is being resumed
 */
export function zeroRateStep({ hasVatable, approved, pending, denied, answer, recovering = false }) {
  if (approved) return ZERO_RATE_STEP.APPROVED;
  if (pending) return ZERO_RATE_STEP.PENDING;
  if (!hasVatable) return ZERO_RATE_STEP.NOT_NEEDED;
  if (answer === "no" || recovering) return ZERO_RATE_STEP.STANDARD;
  if (answer === "yes") return denied ? ZERO_RATE_STEP.DENIED : ZERO_RATE_STEP.REQUESTING;
  return ZERO_RATE_STEP.UNANSWERED;
}

/** Why Finalize must wait at this step, or "" when it may go ahead. */
export function zeroRateStepBlock(step) {
  switch (step) {
    case ZERO_RATE_STEP.UNANSWERED:
      return "Answer the zero-rating question first: is this a zero-rated sale?";
    case ZERO_RATE_STEP.REQUESTING:
      return "Send the zero-rating request to Admin, or choose “No — standard VAT”.";
    case ZERO_RATE_STEP.DENIED:
      return "Admin denied zero-rating for this order. Request again, or choose “No — standard VAT”.";
    default:
      // PENDING is held by zeroRateCheckoutBlock, which also covers sending.
      return "";
  }
}

/** The price review waits while the VAT basis of the prices is still open. */
export function pricingLockedReason(step) {
  switch (step) {
    case ZERO_RATE_STEP.UNANSWERED:
      return "Answer the zero-rating question above first. Prices depend on whether VAT applies.";
    case ZERO_RATE_STEP.REQUESTING:
    case ZERO_RATE_STEP.DENIED:
      return "Prices open once you send the zero-rating request and Admin decides, or choose “No — standard VAT”.";
    case ZERO_RATE_STEP.PENDING:
      return "Prices open when Admin decides. If approved, VAT is removed from the VATable items.";
    default:
      return "";
  }
}

/**
 * Changing the answer to or from "yes" changes the VAT basis the prices are
 * quoted on, so agreed prices typed on VATable lines no longer mean the same
 * amount and are cleared (the rep is told to re-enter them).
 */
export function answerChangeClearsPrices(from, to) {
  return from !== to && (from === "yes" || to === "yes");
}
