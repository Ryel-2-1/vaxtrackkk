import { itemVatLabel } from "./vatClassification.js";
import { describeAllocation } from "./backorder.js";

/**
 * The Med Rep order confirmation, built ONLY from the stored order.
 *
 * The confirmation used to be assembled from checkout's own state. A retry
 * under the same request ID can legitimately be replayed by the server as the
 * ORIGINAL order — and the server's fingerprint ignores priority, instructions
 * and the requested date — so a confirmation built from the (possibly edited)
 * form could show values that were never stored. It is now built from the
 * order document the callable named, re-read after the commit.
 *
 * If that read fails, NOTHING from the checkout is shown as confirmed: the
 * result is marked unverified and carries only the server-returned order id
 * and order number, so the rep is sent to Order Tracking instead.
 *
 * PURE: the loader is injected (`orderService.getOrderById` in the app, a fake
 * in tests).
 */

const centsOrNull = (v) => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);

/** The confirmation record for a stored [order]. */
export function buildConfirmationFromOrder(order, { replayed = false } = {}) {
  const items = Array.isArray(order?.items) ? order.items : [];
  // Reserved / backordered as the SERVER wrote them — a future order shows
  // exactly how much is held now and how much waits for stock.
  const allocation = describeAllocation(order);
  return {
    verified: true,
    replayed: replayed === true,
    id: order.id,
    orderNumber: order.orderNumber || order.id,
    status: order.status ?? null,
    doctorName: order.doctorName ?? null,
    destinationType: order.destinationType ?? null,
    destinationName: order.destinationName ?? null,
    clinicName: order.clinicName ?? order.destinationName ?? null,
    clinicAddress: order.clinicAddress ?? order.deliveryAddress ?? null,
    requestedDeliveryDate: order.requestedDeliveryDate ?? null,
    // The requested arrival at the destination as the server stored it; null
    // on an order placed before it existed (read as any time that day).
    requestedArrival: order.requestedArrival ?? null,
    priority: order.priority ?? null,
    deliveryInstructions: order.deliveryInstructions ?? "",
    items: items.map((item, index) => ({
      inventoryId: item?.inventoryId ?? null,
      name: item?.name ?? null,
      sku: item?.batchId ?? null,
      chain: item?.chain ?? null,
      quantity: Number(item?.quantity) || 0,
      unit: "vials",
      // Server-written centavos only — never a client expectation.
      unitPriceCentavos: typeof item?.unitPriceCentavos === "number" ? item.unitPriceCentavos : null,
      lineTotalCentavos: typeof item?.lineTotalCentavos === "number" ? item.lineTotalCentavos : null,
      // The stored VAT snapshot — "Not recorded" on an order created before
      // snapshots, never inferred from the product's current value.
      vatLabel: itemVatLabel(item),
      reservedQuantity: allocation.lines[index]?.reserved ?? null,
      backorderedQuantity: allocation.lines[index]?.backordered ?? null,
      // Negotiated pricing, as the server recorded it. An order placed before
      // negotiated pricing reads as "at its standard price" — nothing is inferred.
      standardUnitPriceCentavos: centsOrNull(item?.standardUnitPriceCentavos) ?? centsOrNull(item?.unitPriceCentavos),
      priceNegotiated: item?.priceNegotiated === true,
      negotiatedAdjustmentCentavos: Number.isSafeInteger(item?.negotiatedAdjustmentCentavos) ? item.negotiatedAdjustmentCentavos : 0,
      negotiationReason: typeof item?.negotiationReason === "string" ? item.negotiationReason : null,
      // The line's statutory (SC/PWD) discount — separate from the negotiation —
      // and what the line is charged after it.
      statutoryDiscountType: typeof item?.statutoryDiscountType === "string" ? item.statutoryDiscountType : null,
      statutoryDiscountCentavos: Number.isSafeInteger(item?.statutoryDiscountCentavos) ? item.statutoryDiscountCentavos : 0,
      finalLineTotalCentavos: centsOrNull(item?.finalLineTotalCentavos) ?? centsOrNull(item?.lineTotalCentavos),
    })),
    // Order-level negotiated pricing and the VAT breakdown of the agreed total.
    standardSubtotalCentavos: centsOrNull(order.standardSubtotalCentavos),
    negotiatedAdjustmentTotalCentavos: Number.isSafeInteger(order.negotiatedAdjustmentTotalCentavos) ? order.negotiatedAdjustmentTotalCentavos : 0,
    priceNegotiated: order.priceNegotiated === true,
    statutoryDiscountTotalCentavos: Number.isSafeInteger(order.statutoryDiscountTotalCentavos) ? order.statutoryDiscountTotalCentavos : 0,
    // What the clinic is charged. An order placed before line discounts has
    // no separate final total: its subtotal is the amount charged.
    finalTotalCentavos: centsOrNull(order.finalTotalCentavos) ?? centsOrNull(order.subtotalCentavos),
    vatSummary: order.vatSummary && typeof order.vatSummary === "object" ? order.vatSummary : null,
    allocation: allocation.tracked
      ? {
          state: allocation.state,
          label: allocation.label,
          fullyReserved: allocation.fullyReserved,
          requested: allocation.requested,
          reserved: allocation.reserved,
          backordered: allocation.backordered,
        }
      : null,
    subtotalCentavos: typeof order.subtotalCentavos === "number" ? order.subtotalCentavos : null,
    priceCurrency: order.priceCurrency ?? null,
    priceIsVatInclusive: order.priceIsVatInclusive ?? null,
  };
}

/**
 * The parts of a confirmation that may change after the order is placed:
 * where it is in its lifecycle (status) and how much of it is reserved
 * (allocation). Everything else is the record of what was ordered and agreed.
 */
export const CONFIRMATION_LIFECYCLE_FIELDS = Object.freeze(["status", "allocation"]);

/**
 * [record] — the confirmation checkout stored (buildConfirmationFromOrder) —
 * with ONLY its lifecycle brought up to date from [liveOrder].
 *
 * The financial record never changes here: the ordered items, their
 * quantities, the agreed VAT-inclusive unit prices and line totals, the
 * standard prices and negotiated adjustments with their reasons, each line's
 * VAT classification, the subtotal, the VAT breakdown and the price convention
 * all stay exactly as placed — whatever the live order, the inventory or the
 * catalog say later. A
 * confirmation is a record of an agreement, not a view of current prices.
 *
 * Per line, only the reserved / backordered split is refreshed, and only when
 * the live order still has the same number of lines in the same order.
 */
export function withLiveLifecycle(record, liveOrder) {
  if (!record || record.verified !== true || !liveOrder || liveOrder.id !== record.id) return record;
  const live = buildConfirmationFromOrder(liveOrder, { replayed: record.replayed === true });
  const items = Array.isArray(record.items) ? record.items : [];
  const sameLines = live.items.length === items.length;
  return {
    ...record,
    status: live.status ?? record.status ?? null,
    allocation: live.allocation ?? record.allocation ?? null,
    items: sameLines
      ? items.map((item, index) => ({
          ...item,
          reservedQuantity: live.items[index].reservedQuantity ?? item.reservedQuantity ?? null,
          backorderedQuantity: live.items[index].backorderedQuantity ?? item.backorderedQuantity ?? null,
        }))
      : items,
  };
}

/**
 * Re-read the order the callable named and build its confirmation.
 *
 * Resolves `{ verified: true, details }` from the stored document, or
 * `{ verified: false, details }` where `details` carries only the server's
 * order id and number — never checkout values — when the read fails, returns
 * nothing, or returns a different document.
 */
export async function loadAuthoritativeConfirmation({ orderId, orderNumber, replayed, loadOrder }) {
  const unverified = {
    verified: false,
    details: {
      verified: false,
      replayed: replayed === true,
      id: orderId ?? null,
      orderNumber: orderNumber ?? null,
    },
  };
  if (typeof orderId !== "string" || orderId === "") return unverified;
  try {
    const order = await loadOrder(orderId);
    if (!order || order.id !== orderId) return unverified;
    return { verified: true, details: buildConfirmationFromOrder(order, { replayed }) };
  } catch {
    return unverified;
  }
}
