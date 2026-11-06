"use strict";

const { PolicyError } = require("./policy");

const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;

async function getCancelledShipmentAudit({ db, uid, payload }) {
  const callerSnap = await db.collection("users").doc(uid).get();
  const caller = callerSnap.exists ? callerSnap.data() : null;
  if (!caller) throw new PolicyError("profile-missing", "Your account profile could not be found.");
  if (text(caller.role)?.toLowerCase() !== "dispatcher" || text(caller.status)?.toLowerCase() !== "approved") {
    throw new PolicyError("wrong-role", "Only an approved Dispatcher can view this cancellation audit.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      Object.keys(payload).some((key) => key !== "orderId") ||
      !text(payload.orderId) || payload.orderId !== payload.orderId.trim() ||
      payload.orderId.includes("/") || payload.orderId.length > 960) {
    throw new PolicyError("invalid-payload", "Choose a valid cancelled order.");
  }
  const orderId = payload.orderId;
  const orderSnap = await db.collection("orders").doc(orderId).get();
  if (!orderSnap.exists) throw new PolicyError("order-not-found", "That order no longer exists.");
  const order = orderSnap.data();
  if (order.status !== "cancelled" && order.status !== "canceled") {
    throw new PolicyError("invalid-status", "This order is not cancelled.");
  }

  const actorUid = text(order.cancelledByUid);
  const [actorSnap, reservationSnap] = await Promise.all([
    actorUid && !actorUid.includes("/") ? db.collection("users").doc(actorUid).get() : Promise.resolve(null),
    db.collection("inventoryReservations").doc(orderId).get(),
  ]);
  const actor = actorSnap?.exists ? actorSnap.data() : null;
  const reservation = reservationSnap.exists ? reservationSnap.data() : null;
  const slices = Array.isArray(reservation?.items) ? reservation.items : [];
  return {
    cancelledByName: text(order.cancelledByName) ?? text(actor?.name) ?? text(actor?.fullName) ?? text(actor?.displayName),
    reservationStatus: text(reservation?.status),
    settlementType: text(reservation?.settlementType),
    slices: slices.filter((slice) => Number.isSafeInteger(slice?.quantity) && slice.quantity > 0)
      .map((slice) => ({
        lineIndex: Number.isSafeInteger(slice.lineIndex) ? slice.lineIndex : null,
        batchId: text(slice.batchId),
        quantity: slice.quantity,
      })),
  };
}

module.exports = { getCancelledShipmentAudit };
