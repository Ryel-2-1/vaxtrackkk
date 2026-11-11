import { useMemo, useState } from "react";
import {
  agreedInputFor,
  priceReviewLine,
  reviewProblems,
  summarizeReviewVat,
} from "../../services/negotiatedPricing";
import { readVatClassification } from "../../services/vatClassification";
import { quoteUnitPrice } from "../../services/vatQuote";

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
export default function useCheckoutPriceReview({ initialNegotiation, displayItems, batches, vaccinesById, approvedZeroRate = false }) {
  const [negotiation, setNegotiation] = useState(initialNegotiation);
  const reviewLines = useMemo(() => {
    const batchById = new Map((batches || []).map((b) => [b.id, b]));
    return displayItems.map((item) => {
      const vaccine = vaccinesById.get(batchById.get(item.inventoryId)?.vaccineId);
      const vatClassification = readVatClassification(vaccine?.vatClassification) ?? item.vatClassification ?? null;
      const batch = batchById.get(item.inventoryId);
      const quoted = batch && vatClassification && typeof batch.priceIsVatInclusive === "boolean" &&
        Number.isSafeInteger(item.expectedUnitPriceCentavos) && item.expectedUnitPriceCentavos > 0
        ? quoteUnitPrice({ enteredCentavos: item.expectedUnitPriceCentavos, priceIsVatInclusive: batch.priceIsVatInclusive, productVatClassification: vatClassification, approvedZeroRate })
        : null;
      const quotedUnitPriceCentavos = quoted?.unitPriceCentavos ?? item.expectedUnitPriceCentavos;
      // Approved zero-rating took the VAT off a VATable line: keep the price it
      // had with VAT, so the rep sees what changed ("₱1,000.00 → ₱892.86").
      const withVat = approvedZeroRate && quoted && vatClassification === "vatable"
        ? quoteUnitPrice({ enteredCentavos: item.expectedUnitPriceCentavos, priceIsVatInclusive: batch.priceIsVatInclusive, productVatClassification: vatClassification }).unitPriceCentavos
        : null;
      const entry = negotiation[item.inventoryId] || {};
      return {
        item,
        /** The product's own class, before any approved zero-rating. */
        productVatClassification: vatClassification,
        vatRemoved: withVat !== null && withVat > quotedUnitPriceCentavos
          ? { fromUnitCentavos: withVat, toUnitCentavos: quotedUnitPriceCentavos, lineCentavos: (withVat - quotedUnitPriceCentavos) * Number(item.quantity) }
          : null,
        catalogSku: typeof vaccine?.internalSku === "string" && vaccine.internalSku.trim() ? vaccine.internalSku.trim() : null,
        vatClassification: quoted?.vatClassification ?? vatClassification,
        agreedText: entry.agreedInput ?? agreedInputFor(quotedUnitPriceCentavos),
        reasonText: entry.reason ?? "",
        // No SC/PWD discount is entered at checkout, so none is passed: the
        // line is reviewed — and sent — at its agreed price with no discount.
        price: priceReviewLine({
          quantity: item.quantity,
          expectedUnitPriceCentavos: quotedUnitPriceCentavos,
          vatClassification: quoted?.vatClassification ?? vatClassification,
          agreedInput: entry.agreedInput,
          negotiationReason: entry.reason ?? "",
        }),
      };
    });
  }, [displayItems, batches, vaccinesById, negotiation, approvedZeroRate]);
  const baseSummary = summarizeReviewVat(reviewLines.map((l) => l.price));
  // How much VAT approved zero-rating took off the standard prices (shown as
  // its own row in the tally; the totals above it already exclude it).
  const vatRemovedCentavos = reviewLines.reduce((sum, l) => sum + (l.vatRemoved?.lineCentavos ?? 0), 0);
  const priceSummary = baseSummary ? { ...baseSummary, vatRemovedCentavos } : baseSummary;
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
