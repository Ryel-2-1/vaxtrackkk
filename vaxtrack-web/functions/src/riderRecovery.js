"use strict";

/**
 * Admin Rider recovery — the decisions (pure). Transactions: riderRecoveryOps.js.
 *
 * Three recoveries, from the safest:
 *
 *   recheck         recheckRiderTripStates, unchanged: re-derive the Rider's
 *                   trip state from their orders. Never frees a Rider who left.
 *   confirm_return  confirmRiderReturnToHub's decision, unchanged, with an Admin
 *                   reason and an audit record: returning_to_hub → available
 *                   once every trip order is finished.
 *   qa_reset        STAGING / DEMO ONLY. Dissolve a trip that never left the hub:
 *                   its assigned orders go back to pending_dispatch (reservations
 *                   untouched), the Rider becomes available_at_hub. Refused the
 *                   moment anything says a vial was handled or left the hub.
 *
 * Everything here decides from documents the server read in one transaction;
 * nothing a caller sends (order ids, trip ids, statuses, custody) is used.
 */

const { loadingCustodyConfirmed } = require("./policy");
const D = require("./riderDispatch");

/** Production. Never eligible for a QA reset, whatever else is configured. */
const PRODUCTION_PROJECT_IDS = Object.freeze(["vaxtrack-bef1b"]);
/** Explicitly allowed QA projects (exact), plus local emulator demo projects. */
const QA_RESET_PROJECT_IDS = Object.freeze(["vaxtrack-staging"]);
const DEMO_PROJECT = /^demo-vaxtrack-[a-z0-9-]+$/;

/**
 * May this deployment perform a QA reset? BOTH must hold: the project is an
 * allowed staging/demo project, AND the server-side switch is on
 * (QA_RIDER_RESET_ENABLED=true in functions/.env.<projectId>). Fails closed:
 * an unknown project, production, or a missing/other flag value → disabled.
 */
function qaResetConfig({ projectId, flag }) {
  const id = typeof projectId === "string" ? projectId.trim() : "";
  if (!id || PRODUCTION_PROJECT_IDS.includes(id)) return { enabled: false, projectId: id || null, why: "production" };
  if (!QA_RESET_PROJECT_IDS.includes(id) && !DEMO_PROJECT.test(id)) return { enabled: false, projectId: id, why: "project-not-allowed" };
  if (flag !== true && flag !== "true") return { enabled: false, projectId: id, why: "flag-off" };
  return { enabled: true, projectId: id, why: null };
}

const present = (v) => v !== undefined && v !== null && v !== "";

/**
 * Any sign the order's vials were ever confirmed as loaded: the flag, or ANY
 * part of the immutable loading audit — stricter than a complete audit, because
 * a partial record is still evidence that someone handled the vials.
 */
function loadingEvidence(order) {
  return loadingCustodyConfirmed(order) || present(order?.loadedAt) || present(order?.loadedByUid);
}

const millisOf = (v) => {
  if (v instanceof Date) return v.getTime();
  if (v && typeof v.toMillis === "function") {
    try {
      return v.toMillis();
    } catch {
      return null;
    }
  }
  return null;
};

/**
 * Did the order leave the hub in its CURRENT custody epoch? A requeued failed
 * order keeps its old dispatchedAt (requeueFailedOrder starts a new epoch at
 * requeuedAt); only a departure after the latest requeue counts. A departure
 * whose time cannot be compared is treated as current (fail closed).
 */
function travelledThisEpoch(order) {
  if (!order) return false;
  if (order.status === "delivered" || order.status === "delivery_failed") return true;
  if (!present(order.dispatchedAt)) return false;
  const dispatched = millisOf(order.dispatchedAt);
  const requeued = millisOf(order.requeuedAt);
  return !(dispatched !== null && requeued !== null && requeued > dispatched);
}

const STATUS_LABELS = Object.freeze({
  pending_dispatch: "Pending dispatch",
  assigned: "Assigned",
  loading: "Loading",
  in_transit: "In transit",
  delayed: "Delayed",
  delivered: "Delivered",
  delivery_failed: "Delivery failed",
  cancelled: "Cancelled",
});

function orderLabel(order) {
  const n = typeof order?.orderNumber === "string" && order.orderNumber.trim() ? order.orderNumber.trim() : null;
  return n ?? "An order without an order number";
}

/** How the Admin should read an order's custody. */
function custodyOf(order) {
  if (!order) return "unknown";
  if (D.DEPARTED.includes(order.status)) return "with-rider";
  if (order.isLoaded === true) return "loaded";
  if (loadingEvidence(order)) return "loaded-before";
  if (travelledThisEpoch(order)) return "travelled";
  return "not-loaded";
}

/**
 * Should a pending return block anything? Only one still `pending` (an Admin
 * has not decided it) — a resolved return's vials are already accounted for.
 */
const pendingReturns = (list) => (Array.isArray(list) ? list.filter((r) => r?.data?.status === "pending") : []);

/**
 * The QA-reset decision.
 *
 * Input (all read in ONE transaction by the caller):
 *   riderUid, rider        the Rider's user document (null when missing)
 *   stored                 riderDispatchStates/{riderUid} data (null when none)
 *   trip                   the stored trip's riderTrips document (null/undefined)
 *   next                   riderDispatch.reconcile(...) for the same reads
 *   riderOrders            [{ id, data }] every order assigned to the Rider
 *   memberOrders           Map id → data|null for the stored members/held orders
 *   returnsByOrder         Map orderId → [{ id, data }] inventoryReturns for it
 *   referencedTrips        Map tripId → data|null, for trip ids named by orders
 *   navigation             riderNavigationSessions/{riderUid} data (null)
 *   config                 qaResetConfig(...)
 *
 * Output: { enabled, available, noop, blockers[], requeueOrderIds[], dissolveTripIds[] }
 * Each blocker: { code, message, orderNumber? } — sentences an Admin reads.
 */
function assessQaReset({
  riderUid,
  rider,
  stored,
  trip,
  next,
  riderOrders = [],
  memberOrders = new Map(),
  returnsByOrder = new Map(),
  referencedTrips = new Map(),
  navigation = null,
  config,
}) {
  const blockers = [];
  const block = (code, message, order = null) => blockers.push({ code, message, ...(order ? { orderNumber: order } : {}) });

  if (!config?.enabled) {
    return {
      enabled: false,
      available: false,
      noop: false,
      blockers: [{ code: "qa-reset-disabled", message: "QA trip reset is turned off for this project." }],
      requeueOrderIds: [],
      dissolveTripIds: [],
    };
  }
  if (!rider || rider.role !== "rider") {
    block("not-a-rider", "This account is not a rider.");
  }
  if (next?.unknown) {
    const named = (next.orderIds ?? []).map((id) => orderLabel(memberOrders.get(id) ?? riderOrders.find((o) => o.id === id)?.data)).join(", ");
    block("rider-state-unknown", `Some of this rider's orders have a status that can't be checked (${named}). An Admin must review them first.`);
  }

  // ---- departure: anything that says the trip, or an order on it, left the hub
  const storedTripId = typeof stored?.tripId === "string" && stored.tripId ? stored.tripId : null;
  const tripDeparted =
    present(stored?.departedAt) ||
    present(trip?.departedAt) ||
    trip?.status === "departed" ||
    stored?.state === D.STATE.ON_TRIP ||
    (!next?.unknown && !next?.unchanged && next?.state === D.STATE.ON_TRIP);
  if (tripDeparted) {
    block(
      "trip-departed",
      "This rider's trip has left the hub. Use Confirm returned to hub once every order on it is finished."
    );
  }
  // A member of the stored trip that travelled with this Rider: the trip happened.
  const memberIds = [...new Set([...(stored?.orderIds ?? []), ...(stored?.heldOrderIds ?? [])])];
  for (const id of memberIds) {
    const o = memberOrders.get(id);
    if (!o || o.assignedRiderId !== riderUid) continue;
    if (present(o.dispatchTripId) && storedTripId && o.dispatchTripId !== storedTripId) continue;
    if (travelledThisEpoch(o) && !tripDeparted) {
      block("trip-departed", `${orderLabel(o)} already went out with this rider. Use Confirm returned to hub instead.`, orderLabel(o));
    }
  }

  if (navigation && navigation.state === "navigating" && !present(navigation.endedAt)) {
    block("navigation-active", "The rider app is still navigating a delivery. Ask the rider to end navigation, then preview again.");
  }

  // ---- every order assigned to the Rider
  const requeue = [];
  for (const { id, data: o } of riderOrders) {
    const label = orderLabel(o);
    if (D.DEPARTED.includes(o?.status)) {
      block("order-on-the-road", `${label} is ${STATUS_LABELS[o.status].toLowerCase()} — its vials are with the rider.`, label);
      continue;
    }
    if (o?.status === "delivery_failed") {
      block("order-failed", `${label} failed delivery and its vials are on their way back for inspection.`, label);
      continue;
    }
    if (!D.PRE_DEPARTURE.includes(o?.status)) continue; // settled or pending: not on the trip
    if (o.status === "loading") {
      if (loadingEvidence(o)) {
        block("order-loaded", `${label} was confirmed as loaded in Cargo Loading, so its vials were handled.`, label);
      } else {
        // The lifecycle has no way back from Loading, and Loading is reached
        // only by confirming the vials as loaded — so a Loading order with no
        // loading record is an unexplained state, not proof the vials are on
        // the shelf.
        block(
          "loading-not-requeueable",
          `${label} is in Loading. Orders can't be moved back from Loading, and without a loading record it can't be confirmed where its vials are.`,
          label
        );
      }
      continue;
    }
    // assigned
    if (loadingEvidence(o)) {
      block("order-loaded", `${label} was confirmed as loaded in Cargo Loading, so its vials were handled.`, label);
      continue;
    }
    if (travelledThisEpoch(o)) {
      block("order-travelled", `${label} has already left the hub on a dispatch.`, label);
      continue;
    }
    if (pendingReturns(returnsByOrder.get(id)).length > 0) {
      block("return-pending", `${label} has returned vials still waiting for Admin inspection.`, label);
      continue;
    }
    if (present(o.dispatchTripId) && o.dispatchTripId !== storedTripId) {
      const other = referencedTrips.get(o.dispatchTripId);
      if (!other || other.riderUid !== riderUid || other.status === "departed" || present(other.departedAt)) {
        block(
          "membership-inconsistent",
          `${label} is recorded on a different trip. Use Re-check trip status, then preview again.`,
          label
        );
        continue;
      }
    }
    requeue.push(id);
  }
  // A pending return on any stored member (e.g. a cancelled-after-loading order).
  for (const id of memberIds) {
    if (requeue.includes(id)) continue;
    if (pendingReturns(returnsByOrder.get(id)).length > 0 && memberOrders.get(id)?.assignedRiderId === riderUid) {
      const label = orderLabel(memberOrders.get(id));
      if (!blockers.some((b) => b.orderNumber === label && b.code === "return-pending")) {
        block("return-pending", `${label} has returned vials still waiting for Admin inspection.`, label);
      }
    }
  }

  // The trips a reset closes: the stored one and any older forming trip of
  // THIS Rider an order still names — never another Rider's, never a departed one.
  const dissolve = new Set();
  if (storedTripId && trip && trip.riderUid === riderUid && trip.status !== "departed" && trip.status !== "returned" && trip.status !== "dissolved") {
    dissolve.add(storedTripId);
  }
  for (const [tid, t] of referencedTrips) {
    if (t && t.riderUid === riderUid && t.status === "forming") dissolve.add(tid);
  }

  const atHub = (!stored || stored.state === D.STATE.AVAILABLE) && (next?.unchanged || next?.state === D.STATE.AVAILABLE);
  const noop = blockers.length === 0 && requeue.length === 0 && atHub;
  return {
    enabled: true,
    available: blockers.length === 0 && !noop,
    noop,
    blockers,
    requeueOrderIds: requeue.sort(),
    dissolveTripIds: [...dissolve].sort(),
  };
}

/**
 * May an Admin confirm the Rider's return now? The same conditions
 * confirmRiderReturnToHub enforces, decided on the re-derived state `cur`.
 */
function assessConfirmReturn({ cur, riderOrders = [], unknown = false }) {
  if (unknown) return { available: false, message: "Some of this rider's orders can't be checked, so their return can't be confirmed." };
  const out = riderOrders.filter(({ data }) => D.DEPARTED.includes(data?.status));
  if (out.length > 0) {
    return { available: false, message: `Still out for delivery: ${out.map(({ data }) => orderLabel(data)).join(", ")}.` };
  }
  if (cur?.state === D.STATE.RETURNING) return { available: true, message: "Every order on this rider's trip is finished." };
  if (cur?.state === D.STATE.AVAILABLE) return { available: false, message: "This rider is already at the hub." };
  if (cur?.state === D.STATE.FORMING) return { available: false, message: "This rider's trip hasn't left the hub." };
  if (cur?.state === D.STATE.ON_TRIP) return { available: false, message: "This rider is still on a trip." };
  return { available: false, message: "This rider's trip status could not be confirmed." };
}

module.exports = {
  PRODUCTION_PROJECT_IDS,
  QA_RESET_PROJECT_IDS,
  STATUS_LABELS,
  qaResetConfig,
  loadingEvidence,
  travelledThisEpoch,
  custodyOf,
  orderLabel,
  assessQaReset,
  assessConfirmReturn,
};
