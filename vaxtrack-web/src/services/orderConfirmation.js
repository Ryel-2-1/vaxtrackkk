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

/** The confirmation record for a stored [order]. */
export function buildConfirmationFromOrder(order, { replayed = false } = {}) {
  const items = Array.isArray(order?.items) ? order.items : [];
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
    priority: order.priority ?? null,
    deliveryInstructions: order.deliveryInstructions ?? "",
    items: items.map((item) => ({
      inventoryId: item?.inventoryId ?? null,
      name: item?.name ?? null,
      sku: item?.batchId ?? null,
      chain: item?.chain ?? null,
      quantity: Number(item?.quantity) || 0,
      unit: "vials",
      // Server-written centavos only — never a client expectation.
      unitPriceCentavos: typeof item?.unitPriceCentavos === "number" ? item.unitPriceCentavos : null,
      lineTotalCentavos: typeof item?.lineTotalCentavos === "number" ? item.lineTotalCentavos : null,
    })),
    subtotalCentavos: typeof order.subtotalCentavos === "number" ? order.subtotalCentavos : null,
    priceCurrency: order.priceCurrency ?? null,
    priceIsVatInclusive: order.priceIsVatInclusive ?? null,
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
