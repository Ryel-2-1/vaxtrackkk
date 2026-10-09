"use strict";

/**
 * Admin rescheduling of an order's delivery.
 *
 * THE AUTHORITATIVE SCHEDULE stays where it has always been:
 *   requestedDeliveryDate  'YYYY-MM-DD', a Manila calendar day. Written by
 *                          createOrderWithReservation from the Med Rep's
 *                          request, gated for dispatch by firestore.rules
 *                          (scheduleAllowsDispatch) and dispatchEligibility.js.
 * This operation adds only what that field could not express:
 *   scheduledDeliveryTime         'HH:MM' (24h, Asia/Manila) or null.
 *   originalRequestedDeliveryDate the Med Rep's original request, captured ONCE
 *                                 on the first reschedule and never changed
 *                                 again (null for a legacy order that had none).
 *   scheduleRevision / scheduleUpdatedAt / scheduleUpdatedByUid /
 *   scheduleChangeReason          who, when, why — the server's clock and the
 *                                 authenticated uid, never the caller's claim.
 * and appends one immutable entry to orders/{id}/scheduleEvents.
 *
 * Allowed in every non-terminal status, before or after rider assignment or
 * dispatch. It never touches price, VAT, discount, inventory reservation,
 * destination, rider assignment or status — only the fields named above.
 * Moving a dispatched order to a later day does not undo the dispatch; the
 * dispatch rules simply apply again to any FUTURE move into dispatch.
 */

const { PolicyError, isoDateOnly, manilaDateString, validateDocumentId, validateReason } = require("./policy");
const { loadUser, requireRole } = require("./operations");
const { ALLOCATION_VERSION_BACKORDER, allocationPriorityKey } = require("./allocation");

const ORDERS = "orders";
const SCHEDULE_EVENTS = "scheduleEvents";

/** Delivered and cancelled orders are finished; their schedule is history. */
const TERMINAL_STATUSES = new Set(["delivered", "completed", "cancelled", "canceled"]);

const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** 'HH:MM' (00:00–23:59) or null for "no time". Anything else is refused. */
function normalizeScheduleTime(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !TIME_PATTERN.test(value.trim())) {
    throw new PolicyError("invalid-schedule-time", "Enter a delivery time as HH:MM (00:00–23:59), or leave it blank.");
  }
  return value.trim();
}

/** A real date, today in Manila or later. */
function normalizeScheduleDate(value, now) {
  const iso = isoDateOnly(value);
  if (!iso) {
    throw new PolicyError("invalid-schedule-date", "Choose a real delivery date.");
  }
  if (iso < manilaDateString(now)) {
    throw new PolicyError("schedule-date-in-past", "A delivery cannot be scheduled for a day that has already passed.");
  }
  return iso;
}

const PAYLOAD_KEYS = ["orderId", "requestedDeliveryDate", "scheduledDeliveryTime", "reason"];

async function rescheduleOrderDelivery({ db, FieldValue, uid, payload, now }) {
  const userData = await loadUser(db, uid);
  requireRole(userData, "admin");

  const input = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  for (const key of Object.keys(input)) {
    if (!PAYLOAD_KEYS.includes(key)) {
      throw new PolicyError("unknown-field", `A reschedule cannot carry "${key}".`);
    }
  }
  const orderId = validateDocumentId(input.orderId, "That order could not be identified.");
  const date = normalizeScheduleDate(input.requestedDeliveryDate, now);
  const time = normalizeScheduleTime(input.scheduledDeliveryTime);
  const reason =
    input.reason === undefined || input.reason === null || String(input.reason).trim() === ""
      ? null
      : validateReason(input.reason, "reason for the schedule change");

  const orderRef = db.collection(ORDERS).doc(orderId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) {
      throw new PolicyError("order-not-found", "That order no longer exists.");
    }
    const order = snap.data();
    const status = typeof order.status === "string" ? order.status.trim().toLowerCase() : "";
    if (TERMINAL_STATUSES.has(status)) {
      throw new PolicyError("order-closed", "A delivered or cancelled order cannot be rescheduled.");
    }

    const previousDate = typeof order.requestedDeliveryDate === "string" ? order.requestedDeliveryDate : null;
    const previousTime = typeof order.scheduledDeliveryTime === "string" ? order.scheduledDeliveryTime : null;
    if (previousDate === date && previousTime === time) {
      throw new PolicyError("schedule-unchanged", "That is already this order's delivery schedule.");
    }
    const previousRevision = Number.isSafeInteger(order.scheduleRevision) && order.scheduleRevision >= 0
      ? order.scheduleRevision
      : 0;
    const revision = previousRevision + 1;

    const update = {
      requestedDeliveryDate: date,
      scheduledDeliveryTime: time,
      scheduleRevision: revision,
      scheduleUpdatedAt: FieldValue.serverTimestamp(),
      scheduleUpdatedByUid: uid,
      scheduleChangeReason: reason,
      updatedAt: FieldValue.serverTimestamp(),
    };
    // A new date/time changes this order's place in the stock-allocation queue.
    // The key is recomputed with the same comparator, never patched by hand.
    if (order.allocationVersion === ALLOCATION_VERSION_BACKORDER) {
      update.allocationPriorityKey = allocationPriorityKey(
        { ...order, requestedDeliveryDate: date, scheduledDeliveryTime: time },
        orderId
      );
    }
    // The Med Rep's original request is captured on the FIRST reschedule only.
    if (!Object.hasOwn(order, "originalRequestedDeliveryDate")) {
      update.originalRequestedDeliveryDate = isoDateOnly(previousDate);
    }

    tx.update(orderRef, update);
    tx.set(orderRef.collection(SCHEDULE_EVENTS).doc(), {
      revision,
      fromDate: previousDate,
      fromTime: previousTime,
      toDate: date,
      toTime: time,
      reason,
      orderStatus: status || null,
      changedByUid: uid,
      changedAt: FieldValue.serverTimestamp(),
    });

    return { orderId, requestedDeliveryDate: date, scheduledDeliveryTime: time, revision };
  });
}

module.exports = {
  rescheduleOrderDelivery,
  normalizeScheduleTime,
  normalizeScheduleDate,
  TERMINAL_STATUSES,
};
