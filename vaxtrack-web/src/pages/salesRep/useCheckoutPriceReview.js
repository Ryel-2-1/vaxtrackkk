import { useMemo, useState } from "react";
import {
  agreedInputFor,
  priceReviewLine,
  reviewProblems,
  summarizeReviewVat,
} from "../../services/negotiatedPricing";
import { readVatClassification } from "../../services/vatClassification";

/**
 * The checkout's final price review (negotiated pricing;
 * services/negotiatedPricing.js): the rep's agreed-price TEXT and reason per
 * line, keyed by batch, and everything derived from it. A line with no entry
 * is at its standard price. Nothing here is a total: every figure is derived
 * from quantity × unit price in integer centavos, and the server recomputes
 * all of it from the batch it re-reads.
 *
 * [displayItems] are the cart lines as shown (cartLiveStock.liveCartLines);
 * [batches] the cart's live batch documents; [vaccinesById] the cart's
 * products, for the full SKU and the CURRENT VAT class the server will
 * snapshot. Holds no other checkout state and writes nothing.
 */
export default function useCheckoutPriceReview({ initialNegotiation, displayItems, batches, vaccinesById }) {
  const [negotiation, setNegotiation] = useState(initialNegotiation);
  const reviewLines = useMemo(() => {
    const batchById = new Map((batches || []).map((b) => [b.id, b]));
    return displayItems.map((item) => {
      const vaccine = vaccinesById.get(batchById.get(item.inventoryId)?.vaccineId);
      const vatClassification = readVatClassification(vaccine?.vatClassification) ?? item.vatClassification ?? null;
      const entry = negotiation[item.inventoryId] || {};
      return {
        item,
        catalogSku: typeof vaccine?.internalSku === "string" && vaccine.internalSku.trim() ? vaccine.internalSku.trim() : null,
        vatClassification,
        agreedText: entry.agreedInput ?? agreedInputFor(item.expectedUnitPriceCentavos),
        reasonText: entry.reason ?? "",
        // No SC/PWD discount is entered at checkout, so none is passed: the
        // line is reviewed — and sent — at its agreed price with no discount.
        price: priceReviewLine({
          quantity: item.quantity,
          expectedUnitPriceCentavos: item.expectedUnitPriceCentavos,
          vatClassification,
          agreedInput: entry.agreedInput,
          negotiationReason: entry.reason ?? "",
        }),
      };
    });
  }, [displayItems, batches, vaccinesById, negotiation]);
  const priceSummary = summarizeReviewVat(reviewLines.map((l) => l.price));
  const pricingCheck = reviewProblems(reviewLines.map((l) => l.price));
  const reviewByBatch = new Map(reviewLines.map((l) => [l.item.inventoryId, l]));
  const setAgreedInput = (inventoryId, agreedInput) =>
    setNegotiation((current) => ({ ...current, [inventoryId]: { ...current[inventoryId], agreedInput } }));
  const setNegotiationReason = (inventoryId, reason) =>
    setNegotiation((current) => ({ ...current, [inventoryId]: { ...current[inventoryId], reason } }));
  // Reset to standard price: the PRICE follows the standard again and its
  // reason is dropped.
  const resetToStandard = (inventoryId) =>
    setNegotiation((current) => {
      const rest = { ...(current[inventoryId] || {}) };
      delete rest.agreedInput;
      delete rest.reason;
      return { ...current, [inventoryId]: rest };
    });
  // A removed line takes its price and reason with it.
  const clearLinePricing = (inventoryId) =>
    setNegotiation((current) => {
      const next = { ...current };
      delete next[inventoryId];
      return next;
    });

  return {
    negotiation,
    reviewLines,
    priceSummary,
    pricingCheck,
    reviewByBatch,
    setAgreedInput,
    setNegotiationReason,
    resetToStandard,
    clearLinePricing,
  };
}
