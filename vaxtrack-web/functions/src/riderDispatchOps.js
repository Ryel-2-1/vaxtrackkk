"use strict";

/**
 * Rider trips — the transactions (decisions in riderDispatch.js).
 *
 *   assignRiderToOrder        callable  pending_dispatch → assigned, joins the
 *                                       Rider's forming trip (or starts one)
 *   finalizeRiderDispatch     callable  the WHOLE forming trip loading → in_transit
 *   confirmRiderReturnToHub   callable  returning_to_hub → available_at_hub
 *   reconcileRiderOnOrderWrite trigger  membership + settlement after any
 *                                       order change (cancel, deliver, fail,
 *                                       requeue, or a legacy direct write)
 *
 * Each reads the Rider's state document AND every order assigned to the Rider
 * inside one transaction, so concurrent calls serialize on the same documents:
 * two assignments to an available Rider form ONE trip; an assignment racing a
 * Finalize either joins before departure (and blocks the Finalize until it is
 * loaded) or is refused after it. Every operation is safe to repeat.
 *
 * A Rider with no state document (everyone, at rollout) is classified from
 * their orders in the same transaction — never freeing a Rider who is on the
 * road (riderDispatch.classifyFromOrders).
 */

const { PolicyError, hasLoadingAudit } = require("./policy");
const { routeFieldDeletes } = require("./orderRouteFields");
const { statusUpdatedByEmailValue } = require("./attribution");
const D = require("./riderDispatch");

const ORDERS = "orders";
const USERS = "users";
const DISPATCH_ROLES = Object.freeze(["dispatcher", "admin"]);
const MAX_TRIP_ORDERS = 50;

function requestId(value, message) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.includes("/") || id.length > 300) throw new PolicyError("invalid-request", message);
  return id;
}

/** A Dispatcher or an Admin, approved. */
async function loadDispatchActor(db, uid) {
  const snap = await db.collection(USERS).doc(uid).get();
  const user = snap.exists ? snap.data() : null;
  if (!user) throw new PolicyError("profile-missing", "Your account profile could not be found.");
  if (!DISPATCH_ROLES.includes(user.role)) throw new PolicyError("wrong-role", "Your account cannot perform this action.");
  if (user.status !== "approved") throw new PolicyError("not-approved", "Your account is not approved.");
  return user;
}

/**
 * Everything a decision about one Rider needs, read inside the transaction:
 * the state document, every order now assigned to the Rider, and any trip
 * member that has since left them (requeued) — by id.
 */
async function readRiderView(tx, db, riderUid) {
  const stateRef = db.collection(D.RIDER_DISPATCH_STATES).doc(riderUid);
  const stateSnap = await tx.get(stateRef);
  const state = stateSnap.exists ? stateSnap.data() : null;
  const q = await tx.get(db.collection(ORDERS).where("assignedRiderId", "==", riderUid));
  const riderOrders = q.docs.map((d) => ({ id: d.id, data: d.data() }));
  const byId = new Map(riderOrders.map((o) => [o.id, o.data]));
  const wanted = [...(state?.orderIds ?? []), ...(state?.heldOrderIds ?? [])].filter((id) => typeof id === "string" && !byId.has(id));
  for (const id of [...new Set(wanted)]) {
    const s = await tx.get(db.collection(ORDERS).doc(id));
    byId.set(id, s.exists ? s.data() : null);
  }
  return { stateRef, state, riderOrders, byId };
}

const newTripId = (db) => db.collection(D.RIDER_TRIPS).doc().id;

/**
 * Lock contention between two trip transactions on the same Rider (an
 * assignment racing a Finalize) can end one of them with a transaction-level
 * failure that runTransaction does not (always) retry. Exactly these are
 * retried here, a bounded number of times — nothing else:
 *
 *   ABORTED (gRPC 10)          Firestore's contention signal ("too much
 *                              contention", a lost lock). runTransaction
 *                              retries it internally too; this only extends
 *                              that, boundedly.
 *   INVALID_ARGUMENT (gRPC 3)  ONLY when the message is one of the two
 *                              transaction-lifecycle sentences below — the
 *                              transaction was closed under it after a lock
 *                              wait (emulator), or its id expired (production).
 *                              Every other INVALID_ARGUMENT is a real error in
 *                              the request and is thrown at once.
 *
 * Safe: each attempt re-reads everything from scratch, a closed or expired
 * transaction committed nothing, and every operation is idempotent anyway (a
 * repeat after a commit reports a replay). Domain refusals (PolicyError) and
 * every other code are never retried. Admin SDK errors carry numeric gRPC
 * codes; nothing else is matched.
 */
const TRANSIENT_ATTEMPTS = 3;
const GRPC_ABORTED = 10;
const GRPC_INVALID_ARGUMENT = 3;
const TRANSACTION_LIFECYCLE_MESSAGES = Object.freeze([
  "Transaction is invalid or closed",
  "The referenced transaction has expired or is no longer valid",
]);
function isTransientTransactionError(error) {
  if (!error || error instanceof PolicyError) return false;
  if (error.code === GRPC_ABORTED) return true;
  if (error.code !== GRPC_INVALID_ARGUMENT) return false;
  const text = `${typeof error.details === "string" ? error.details : ""} ${typeof error.message === "string" ? error.message : ""}`;
  return TRANSACTION_LIFECYCLE_MESSAGES.some((m) => text.includes(m));
}
async function runTripTransaction(db, fn) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.runTransaction(fn);
    } catch (error) {
      if (attempt >= TRANSIENT_ATTEMPTS || !isTransientTransactionError(error)) throw error;
    }
  }
}

/**
 * The state to act on: the stored one, or — for a Rider without a document —
 * the classification of their orders, with its trip id allocated now.
 */
function effectiveState(db, riderUid, view) {
  if (view.state) return { ...view.state, stored: true };
  const c = D.reconcile({ riderUid, current: null, memberOrders: view.byId, riderOrders: view.riderOrders });
  return {
    riderUid,
    state: c.state,
    tripId: c.state === D.STATE.AVAILABLE ? null : newTripId(db),
    orderIds: c.orderIds,
    heldOrderIds: c.heldOrderIds,
    classifyAdopt: c.adoptOrderIds,
    stored: false,
  };
}

/** Write a classified state for the first time (stamping its trip on members). */
function persistClassification(tx, db, FieldValue, eff, view) {
  if (eff.stored) return;
  tx.set(view.stateRef, {
    riderUid: eff.riderUid,
    state: eff.state,
    tripId: eff.tripId,
    orderIds: eff.orderIds,
    heldOrderIds: eff.heldOrderIds,
    classifiedFrom: "orders",
    classifiedAt: FieldValue.serverTimestamp(),
    ...(eff.state === D.STATE.ON_TRIP ? { departedAt: null, departedBy: "legacy" } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  });
  if (eff.tripId) {
    tx.set(db.collection(D.RIDER_TRIPS).doc(eff.tripId), {
      riderUid: eff.riderUid,
      status: eff.state === D.STATE.ON_TRIP ? "departed" : "forming",
      orderIds: eff.orderIds,
      source: "classification",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  for (const id of eff.classifyAdopt ?? []) {
    tx.update(db.collection(ORDERS).doc(id), { dispatchTripId: eff.tripId, updatedAt: FieldValue.serverTimestamp() });
  }
}

const firstText = (...values) => values.find((v) => typeof v === "string" && v.trim() !== "")?.trim() ?? null;

// ------------------------------------------------------------------ assign

async function assignRiderToOrder({ db, FieldValue, uid, email = null, payload, now }) {
  await loadDispatchActor(db, uid);
  const orderId = requestId(payload?.orderId, "That order could not be identified.");
  const riderUid = requestId(payload?.riderUid, "Please select an available rider.");

  return runTripTransaction(db, async (tx) => {
    const orderRef = db.collection(ORDERS).doc(orderId);
    const orderSnap = await tx.get(orderRef);
    const riderSnap = await tx.get(db.collection(USERS).doc(riderUid));
    const view = await readRiderView(tx, db, riderUid);

    if (!orderSnap.exists) throw new PolicyError("order-not-found", "That order no longer exists.");
    const order = orderSnap.data();
    const eff = effectiveState(db, riderUid, view);

    // Repeat of a call that already succeeded: same order, same Rider, same trip.
    if (
      order.assignedRiderId === riderUid &&
      D.PRE_DEPARTURE.includes(order.status) &&
      typeof order.dispatchTripId === "string" &&
      order.dispatchTripId === eff.tripId
    ) {
      return { orderId, riderUid, tripId: eff.tripId, replayed: true };
    }
    if (order.status !== "pending_dispatch") {
      throw new PolicyError("order-not-pending", "That order is no longer awaiting dispatch. Refresh the queue.", { status: order.status ?? null });
    }
    if (typeof order.assignedRiderId === "string" && order.assignedRiderId !== "") {
      throw new PolicyError("order-already-assigned", "That order has already been assigned to a rider.");
    }
    const block = D.dispatchBlock(order, now);
    if (block) throw new PolicyError(block.code, block.message);

    if (!riderSnap.exists) throw new PolicyError("rider-not-found", "That rider account no longer exists.");
    const rider = riderSnap.data();
    if (rider.role !== "rider") throw new PolicyError("not-a-rider", "That account is not a rider.");
    if (rider.status !== "approved") throw new PolicyError("rider-not-approved", "That rider is not approved for assignment.");

    const allowed = D.assignmentAllowed(eff.state);
    if (!allowed.ok) throw new PolicyError(allowed.code, allowed.message, { riderState: eff.state });

    const forming = eff.state === D.STATE.FORMING;
    const tripId = forming ? eff.tripId : newTripId(db);
    const members = forming ? [...new Set([...(eff.orderIds ?? []), orderId])].sort() : [orderId];
    if (members.length > MAX_TRIP_ORDERS) {
      throw new PolicyError("trip-full", `A trip can carry at most ${MAX_TRIP_ORDERS} orders. Dispatch this rider first.`);
    }

    // ---- writes
    if (forming) persistClassification(tx, db, FieldValue, eff, view);
    const assignedRiderName = firstText(rider.fullName, rider.name, rider.displayName, rider.email);
    const assignedRiderPhone = firstText(rider.phone, rider.contactNumber);
    tx.update(orderRef, {
      status: "assigned",
      assignedRiderId: riderUid,
      dispatchTripId: tripId,
      assignedAt: FieldValue.serverTimestamp(),
      assignedByUid: uid,
      statusUpdatedAt: FieldValue.serverTimestamp(),
      statusUpdatedByUid: uid,
      statusUpdatedByEmail: statusUpdatedByEmailValue(email, FieldValue),
      updatedAt: FieldValue.serverTimestamp(),
      ...(assignedRiderName ? { assignedRiderName } : {}),
      ...(assignedRiderPhone ? { assignedRiderPhone } : {}),
      ...(email ? { assignedByEmail: email } : {}),
      // A route drawn for an earlier rider is never navigated by this one.
      ...routeFieldDeletes(order, FieldValue),
    });
    const tripRef = db.collection(D.RIDER_TRIPS).doc(tripId);
    if (forming) {
      tx.set(view.stateRef, { state: D.STATE.FORMING, tripId, orderIds: members, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      tx.set(tripRef, { orderIds: members, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    } else {
      tx.set(view.stateRef, {
        riderUid,
        state: D.STATE.FORMING,
        tripId,
        orderIds: members,
        heldOrderIds: [],
        formedAt: FieldValue.serverTimestamp(),
        formedByUid: uid,
        departedAt: null,
        departedByUid: null,
        settledAt: null,
        updatedAt: FieldValue.serverTimestamp(),
        ...(view.state?.lastConfirmedTripId ? { lastConfirmedTripId: view.state.lastConfirmedTripId } : {}),
      }, view.state ? { merge: true } : undefined);
      tx.set(tripRef, {
        riderUid,
        status: "forming",
        orderIds: members,
        source: "assignment",
        createdAt: FieldValue.serverTimestamp(),
        createdByUid: uid,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    return { orderId, riderUid, tripId, replayed: false, assignedRiderName };
  });
}

// ------------------------------------------------------------------ finalize

async function finalizeRiderDispatch({ db, FieldValue, uid, email = null, payload, now }) {
  await loadDispatchActor(db, uid);
  const riderUid = requestId(payload?.riderUid, "Rider is required.");
  const expectedTripId = payload?.tripId == null ? null : requestId(payload.tripId, "That trip could not be identified.");
  if (!Array.isArray(payload?.orderIds) || payload.orderIds.length === 0 || payload.orderIds.length > MAX_TRIP_ORDERS) {
    throw new PolicyError("invalid-request", "No orders to dispatch.");
  }
  const requested = [...new Set(payload.orderIds.map((id) => requestId(id, "An order could not be identified.")))].sort();

  return runTripTransaction(db, async (tx) => {
    const view = await readRiderView(tx, db, riderUid);
    // Orders named by the caller that the view does not hold yet (a replay
    // after the trip moved on).
    for (const id of requested) {
      if (!view.byId.has(id)) {
        const s = await tx.get(db.collection(ORDERS).doc(id));
        view.byId.set(id, s.exists ? s.data() : null);
      }
    }
    const eff = effectiveState(db, riderUid, view);

    if (eff.state !== D.STATE.FORMING) {
      // A repeat of a Finalize that already ran: every requested order left
      // with this Rider on one trip.
      const tripIds = new Set(requested.map((id) => view.byId.get(id)?.dispatchTripId));
      const departed = requested.every((id) => {
        const o = view.byId.get(id);
        return o && o.assignedRiderId === riderUid && !D.PRE_DEPARTURE.includes(o.status) && typeof o.dispatchedAt !== "undefined";
      });
      const [onlyTrip] = [...tripIds];
      if (departed && tripIds.size === 1 && typeof onlyTrip === "string" && onlyTrip !== "" && (!expectedTripId || onlyTrip === expectedTripId)) {
        return { riderUid, tripId: onlyTrip, dispatchedOrderIds: requested, replayed: true };
      }
      throw new PolicyError(
        eff.state === D.STATE.AVAILABLE ? "trip-not-forming" : "rider-on-trip",
        eff.state === D.STATE.AVAILABLE
          ? "This rider has no orders waiting to be dispatched. Refresh cargo loading."
          : "This rider has already left on a trip. Refresh cargo loading."
      );
    }
    if (expectedTripId && eff.stored && eff.tripId !== expectedTripId) {
      throw new PolicyError("trip-changed", "This rider's trip changed. Refresh cargo loading.");
    }

    // The live trip: members still with this Rider and not cancelled before departure.
    const live = (eff.orderIds ?? []).filter((id) => {
      const o = view.byId.get(id);
      return o && o.assignedRiderId === riderUid && o.status !== "cancelled";
    });
    if (!D.sameIds(live, requested)) {
      throw new PolicyError("trip-changed", "The orders for this rider changed. Refresh cargo loading and dispatch again.");
    }
    for (const id of live) {
      const o = view.byId.get(id);
      if (o.status !== "loading") {
        throw new PolicyError("order-not-dispatchable", "One of these orders is no longer ready for dispatch. Refresh cargo loading.");
      }
      if (o.isLoaded !== true) {
        throw new PolicyError("order-not-loaded", "Every order must be confirmed as loaded before dispatch.");
      }
      const block = D.dispatchBlock(o, now);
      if (block) throw new PolicyError(block.code, block.message);
    }

    // ---- writes
    persistClassification(tx, db, FieldValue, eff, view);
    for (const id of live) {
      const o = view.byId.get(id);
      tx.update(db.collection(ORDERS).doc(id), {
        // A legacy order confirmed before the custody audit existed is stamped
        // as it leaves; an existing audit is never touched.
        ...(hasLoadingAudit(o)
          ? {}
          : { loadedAt: FieldValue.serverTimestamp(), loadedByUid: uid, ...(email ? { loadedByEmail: email } : {}) }),
        status: "in_transit",
        dispatchTripId: eff.tripId,
        dispatchedAt: FieldValue.serverTimestamp(),
        loadingFinalizedAt: FieldValue.serverTimestamp(),
        startedAt: FieldValue.serverTimestamp(),
        statusUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        dispatchedByUid: uid,
        statusUpdatedByUid: uid,
        // The token email, or removed — never the previous writer's.
        statusUpdatedByEmail: statusUpdatedByEmailValue(email, FieldValue),
        ...(email ? { dispatchedByEmail: email } : {}),
      });
    }
    tx.set(view.stateRef, {
      state: D.STATE.ON_TRIP,
      tripId: eff.tripId,
      orderIds: live,
      departedAt: FieldValue.serverTimestamp(),
      departedByUid: uid,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.set(db.collection(D.RIDER_TRIPS).doc(eff.tripId), {
      status: "departed",
      orderIds: live,
      departedAt: FieldValue.serverTimestamp(),
      departedByUid: uid,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { riderUid, tripId: eff.tripId, dispatchedOrderIds: live, replayed: false };
  });
}

// ------------------------------------------------------------------ return to hub

async function confirmRiderReturnToHub({ db, FieldValue, uid, payload }) {
  await loadDispatchActor(db, uid);
  const riderUid = requestId(payload?.riderUid, "Rider is required.");
  const tripId = requestId(payload?.tripId, "That trip could not be identified.");

  return runTripTransaction(db, async (tx) => {
    const view = await readRiderView(tx, db, riderUid);
    const eff = effectiveState(db, riderUid, view);

    if (eff.lastConfirmedTripId === tripId && eff.tripId !== tripId) {
      return { riderUid, tripId, state: eff.state, replayed: true };
    }
    if (eff.tripId !== tripId) {
      throw new PolicyError("trip-changed", "This rider's trip changed. Refresh and try again.");
    }
    if (eff.state !== D.STATE.RETURNING) {
      throw new PolicyError(
        "trip-not-settled",
        eff.state === D.STATE.ON_TRIP
          ? "This rider still has orders out for delivery. Confirm their return once every order is finished."
          : "This rider is not returning from a trip."
      );
    }
    // Re-checked here, not trusted from the stored state.
    const unsettled = (eff.orderIds ?? []).filter((id) => !D.settledForTrip(view.byId.get(id), riderUid, tripId));
    if (unsettled.length > 0) {
      throw new PolicyError("trip-not-settled", "This rider still has orders out for delivery.");
    }
    // Legacy orders assigned while the Rider was already out become the next trip.
    const held = (eff.heldOrderIds ?? []).filter((id) => {
      const o = view.byId.get(id);
      return o && o.assignedRiderId === riderUid && D.PRE_DEPARTURE.includes(o.status);
    });
    const nextTripId = held.length > 0 ? newTripId(db) : null;

    // ---- writes
    persistClassification(tx, db, FieldValue, eff, view);
    tx.set(db.collection(D.RIDER_TRIPS).doc(tripId), {
      status: "returned",
      returnConfirmedAt: FieldValue.serverTimestamp(),
      returnConfirmedByUid: uid,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.set(view.stateRef, {
      state: nextTripId ? D.STATE.FORMING : D.STATE.AVAILABLE,
      tripId: nextTripId,
      orderIds: held,
      heldOrderIds: [],
      lastConfirmedTripId: tripId,
      returnConfirmedAt: FieldValue.serverTimestamp(),
      returnConfirmedByUid: uid,
      departedAt: null,
      departedByUid: null,
      settledAt: null,
      ...(nextTripId ? { formedAt: FieldValue.serverTimestamp(), formedByUid: uid } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    if (nextTripId) {
      tx.set(db.collection(D.RIDER_TRIPS).doc(nextTripId), {
        riderUid,
        status: "forming",
        orderIds: held,
        source: "held-legacy-orders",
        createdAt: FieldValue.serverTimestamp(),
        createdByUid: uid,
        updatedAt: FieldValue.serverTimestamp(),
      });
      for (const id of held) {
        tx.update(db.collection(ORDERS).doc(id), { dispatchTripId: nextTripId, updatedAt: FieldValue.serverTimestamp() });
      }
    }
    return { riderUid, tripId, state: nextTripId ? D.STATE.FORMING : D.STATE.AVAILABLE, nextTripId, replayed: false };
  });
}

// ------------------------------------------------------------------ trigger

const TRIP_FIELDS = ["status", "assignedRiderId", "dispatchTripId"];

/** Did this write change anything a trip depends on? Location fixes etc. do not. */
function tripRelevant(before, after) {
  if (!before || !after) return Boolean((before ?? after)?.assignedRiderId);
  return TRIP_FIELDS.some((f) => (before[f] ?? null) !== (after[f] ?? null));
}

async function reconcileRider({ db, FieldValue, riderUid }) {
  return runTripTransaction(db, async (tx) => {
    const view = await readRiderView(tx, db, riderUid);
    const next = D.reconcile({ riderUid, current: view.state, memberOrders: view.byId, riderOrders: view.riderOrders });
    if (next.unchanged) return { riderUid, changed: false };

    const current = view.state;
    const startsTrip = !current || current.state === D.STATE.AVAILABLE;
    const tripId = next.state === D.STATE.AVAILABLE ? null : (startsTrip || !current?.tripId ? newTripId(db) : current.tripId);
    const stamp = FieldValue.serverTimestamp();

    tx.set(view.stateRef, {
      riderUid,
      state: next.state,
      tripId,
      orderIds: next.orderIds,
      heldOrderIds: next.heldOrderIds,
      updatedAt: stamp,
      ...(current ? {} : { classifiedFrom: "orders", classifiedAt: stamp }),
      ...(next.settled ? { settledAt: stamp } : {}),
      ...(next.departedByLegacyWrite && current?.state !== D.STATE.ON_TRIP ? { departedAt: stamp, departedByUid: null, departedBy: "legacy-client-write" } : {}),
      ...(next.dissolved ? { departedAt: null, departedByUid: null, settledAt: null } : {}),
    }, { merge: true });

    if (tripId) {
      const tripStatus = next.state === D.STATE.FORMING ? "forming" : next.state === D.STATE.ON_TRIP ? "departed" : "settled";
      tx.set(db.collection(D.RIDER_TRIPS).doc(tripId), {
        riderUid,
        status: tripStatus,
        orderIds: next.orderIds,
        ...(next.settled ? { settledAt: stamp } : {}),
        ...(startsTrip ? { source: current ? "legacy-client-write" : "classification", createdAt: stamp } : {}),
        updatedAt: stamp,
      }, { merge: true });
    }
    if (next.dissolved && current?.tripId) {
      tx.set(db.collection(D.RIDER_TRIPS).doc(current.tripId), { status: "dissolved", orderIds: [], updatedAt: stamp }, { merge: true });
    }
    for (const id of next.adoptOrderIds ?? []) {
      if (tripId && view.byId.get(id)?.dispatchTripId !== tripId) {
        tx.update(db.collection(ORDERS).doc(id), { dispatchTripId: tripId, updatedAt: stamp });
      }
    }
    return { riderUid, changed: true, state: next.state, tripId, anomalies: next.anomalies ?? [] };
  });
}

async function reconcileRiderOnOrderWrite({ db, FieldValue, before, after }) {
  if (!tripRelevant(before, after)) return [];
  const riders = [...new Set([before?.assignedRiderId, after?.assignedRiderId].filter((v) => typeof v === "string" && v !== ""))];
  const results = [];
  for (const riderUid of riders) results.push(await reconcileRider({ db, FieldValue, riderUid }));
  return results;
}

module.exports = {
  loadDispatchActor,
  assignRiderToOrder,
  finalizeRiderDispatch,
  confirmRiderReturnToHub,
  reconcileRider,
  reconcileRiderOnOrderWrite,
  tripRelevant,
  MAX_TRIP_ORDERS,
  // Exported for the retry tests.
  isTransientTransactionError,
  runTripTransaction,
  TRANSIENT_ATTEMPTS,
};
