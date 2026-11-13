"use strict";

/**
 * The lots that ACTUALLY hold an order's stock, for its invoice (2026-11-13).
 *
 * Allocation is FEFO per product (allocation.js), so a line can be filled from
 * a different batch than the one it was quoted from, or from several. The
 * invoice must name the stock the clinic receives, so each invoice line gets:
 *
 *   allocatedLots  [{ inventoryId, batchId, lotNumber, expiryDate, quantity }]
 *                  one per batch slice the order's reservation holds or
 *                  consumed (the delivered stock), in FEFO order
 *   lotNumber      the printed "LN" text: one lot's number, or several with
 *                  their quantities ("A123 (6), B456 (4)")
 *   expiry         the matching expiry date(s)
 *
 * The lot printed is the manufacturer's Lot Number when the batch records one,
 * otherwise its Batch ID (every batch created before Lot Number existed).
 *
 * Prices, quantities and totals are untouched: one invoice line per order line
 * as before, so no cell position on the 3MGS yellow form moves. Read-only;
 * called inside the invoice transaction before any write.
 */

const RESERVATIONS = "inventoryReservations";
const INVENTORY = "inventory";
/** A reservation whose slices are (or were, at delivery) the order's stock. */
const LOT_STATUSES = new Set(["reserved", "consumed"]);

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The lot number to print for a batch: its Lot Number, else its Batch ID. */
function printedLot(lot) {
  return text(lot.lotNumber) ?? text(lot.batchId) ?? lot.inventoryId;
}

/** "A123" for one lot; "A123 (6), B456 (4)" for several. */
function lotsLabel(lots) {
  if (!Array.isArray(lots) || lots.length === 0) return "";
  if (lots.length === 1) return printedLot(lots[0]);
  return lots.map((lot) => `${printedLot(lot)} (${lot.quantity})`).join(", ");
}

/** The distinct expiry dates of the lots, in their order. */
function expiriesLabel(lots) {
  if (!Array.isArray(lots)) return "";
  return [...new Set(lots.map((lot) => text(lot.expiryDate)).filter(Boolean))].join(", ");
}

/**
 * orderItems' index → its lots, from the order's reservation. Slices with a
 * lineIndex map to that line; an older slice without one maps to the line
 * quoted from the same batch. Empty when there is no reservation (legacy order)
 * or it was released or returned.
 */
async function readInvoiceLots(tx, db, orderId, orderItems) {
  const byLine = new Map();
  const resSnap = await tx.get(db.collection(RESERVATIONS).doc(orderId));
  if (!resSnap.exists) return byLine;
  const reservation = resSnap.data();
  if (!LOT_STATUSES.has(reservation?.status ?? "reserved")) return byLine;
  const slices = (Array.isArray(reservation.items) ? reservation.items : [])
    .filter((s) => typeof s?.inventoryId === "string" && s.inventoryId && Number.isInteger(s.quantity) && s.quantity > 0);
  const items = Array.isArray(orderItems) ? orderItems : [];

  const batches = new Map();
  for (const id of new Set(slices.map((s) => s.inventoryId))) {
    const snap = await tx.get(db.collection(INVENTORY).doc(id));
    batches.set(id, snap.exists ? snap.data() : null);
  }

  for (const slice of slices) {
    const line = Number.isSafeInteger(slice.lineIndex) && slice.lineIndex >= 0 && slice.lineIndex < items.length
      ? slice.lineIndex
      : items.findIndex((it) => it?.inventoryId === slice.inventoryId);
    if (line < 0) continue;
    const batch = batches.get(slice.inventoryId);
    const lots = byLine.get(line) ?? [];
    const same = lots.find((lot) => lot.inventoryId === slice.inventoryId);
    if (same) {
      same.quantity += slice.quantity;
    } else {
      lots.push({
        inventoryId: slice.inventoryId,
        batchId: text(batch?.batchId) ?? text(slice.batchId),
        lotNumber: text(batch?.lotNumber),
        expiryDate: text(batch?.expiryDate),
        quantity: slice.quantity,
      });
    }
    byLine.set(line, lots);
  }
  return byLine;
}

/** The invoice base items with their actual lots attached (new objects). */
function withInvoiceLots(baseItems, lotsByLine) {
  return baseItems.map((item, index) => {
    const lots = lotsByLine.get(index) ?? [];
    if (lots.length === 0) return item;
    return { ...item, allocatedLots: lots, lotNumber: lotsLabel(lots), expiry: expiriesLabel(lots) };
  });
}

module.exports = { readInvoiceLots, withInvoiceLots, lotsLabel, expiriesLabel, printedLot };
