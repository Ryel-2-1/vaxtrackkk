"use strict";

/**
 * Rider trips — the transactions (decisions in riderDispatch.js).
 *
 *   assignRiderToOrder        callable  pending_dispatch → assigned, joins the
 *                                       Rider's forming trip (or starts one)
 *   finalizeRiderDispatch     callable  the WHOLE forming trip loading → in_transit
 *   confirmRiderReturnToHub   callable  returning_to_hub → available_at_hub
 *   recheckRiderTripStates    callable  repair: re-derive named Riders' trip
 *                                       state from their orders (never frees one)
 *   reconcileRiderOnOrderWrite trigger  membership + settlement after any
 *                                       order change (cancel, deliver, fail,
 *                                       requeue, or a legacy direct write)
 *
 * The stored `riderDispatchStates` document is NOT authoritative on its own.
 * Every decision first re-derives the Rider's state from EVERY order now
 * assigned to them (riderDispatch.reconcile) inside the transaction that acts on
 * it, so a state left stale by a missed or out-of-order trigger event can never
 * authorize an assignment, a departure or a release:
 *
 *   - Each callable first runs the same re-derivation in its own transaction
 *     (`reconcileRider`), so a correction is committed even when the action is
 *     then refused; it re-derives again inside its decision transaction, so a
 *     change in between is honoured.
 *   - An order on the road keeps the Rider on_trip; a finished trip leaves them
 *     returning_to_hub; only confirmRiderReturnToHub (a Dispatcher or Admin
 *     confirming the physical return) makes them available.
 *   - An assigned order whose status cannot be placed stops every decision for
 *     that Rider (fail closed).
 *
 * Each transaction reads the Rider's state, their server trip document AND
 * every order assigned to them, so concurrent calls serialize on the same
 * documents: two assignments to an available Rider form ONE trip; an
 * assignment racing a Finalize either joins before departure (and blocks the
 * Finalize until it is loaded) or is refused after it. Every operation is safe
 * to repeat.
 */

const { PolicyError, hasLoadingAudit } = require("./policy");
const { usableThrough, assertBatchesCover, readReservedBatches } = require("./expiryGuard");
const { routeFieldDeletes } = require("./orderRouteFields");
const { statusUpdatedByEmailValue } = require("./attribution");
const D = require("./riderDispatch");

const ORDERS = "orders";
const USERS = "users";
const DISPATCH_ROLES = Object.freeze(["dispatcher", "admin"]);
const MAX_TRIP_ORDERS = 50;
/** The repair operation names its Riders; at most this many per call. */
const MAX_RECHECK_RIDERS = 25;

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
 * the state document, its server trip document, every order now assigned to
 * the Rider, any trip member that has since left them (requeued) — and any
 * further orders the caller names — by id. Reads only.
 */
async function readRiderView(tx, db, riderUid, extraOrderIds = []) {
  const stateRef = db.collection(D.RIDER_DISPATCH_STATES).doc(riderUid);
  const stateSnap = await tx.get(stateRef);
  const state = stateSnap.exists ? stateSnap.data() : null;
  const q = await tx.get(db.collection(ORDERS).where("assignedRiderId", "==", riderUid));
  const riderOrders = q.docs.map((d) => ({ id: d.id, data: d.data() }));
  const byId = new Map(riderOrders.map((o) => [o.id, o.data]));
  const wanted = [...(state?.orderIds ?? []), ...(state?.heldOrderIds ?? []), ...extraOrderIds].filter(
    (id) => typeof id === "string" && id !== "" && !id.includes("/") && !byId.has(id)
  );
  for (const id of [...new Set(wanted)]) {
    const s = await tx.get(db.collection(ORDERS).doc(id));
    byId.set(id, s.exists ? s.data() : null);
  }
  // The server trip the document names (never the route optimizer's tripId).
  let trip;
  if (typeof state?.tripId === "string" && state.tripId !== "" && !state.tripId.includes("/")) {
    const t = await tx.get(db.collection(D.RIDER_TRIPS).doc(state.tripId));
    trip = t.exists ? t.data() : null;
  }
  return { stateRef, state, riderOrders, byId, trip };
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

// ------------------------------------------------------------------ authoritative state

const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x !== "") : []);

/** The stored document as the shape decisions use (only when it agrees with the orders). */
function fromStored(riderUid, state) {
  return {
    riderUid,
    state: state.state,
    tripId: typeof state.tripId === "string" && state.tripId !== "" ? state.tripId : null,
    orderIds: ids(state.orderIds),
    heldOrderIds: ids(state.heldOrderIds),
    lastConfirmedTripId: state.lastConfirmedTripId ?? null,
  };
}

/**
 * Write a re-derived state (riderDispatch.reconcile's output) in the current
 * transaction: the state document, the server trip document, and the trip id
 * on every adopted order. Writes only — call after every read. Returns the
 * state decisions use from here on.
 */
function applyNext(tx, db, FieldValue, view, riderUid, next) {
  const current = view.state;
  const tripId = next.state === D.STATE.AVAILABLE ? null : next.newTrip ? newTripId(db) : next.tripId;
  const stamp = FieldValue.serverTimestamp();
  tx.set(view.stateRef, {
    riderUid,
    state: next.state,
    tripId,
    orderIds: next.orderIds,
    heldOrderIds: next.heldOrderIds,
    updatedAt: stamp,
    ...(current ? {} : { classifiedFrom: "orders", classifiedAt: stamp }),
    ...(!current && next.state === D.STATE.ON_TRIP ? { departedAt: null, departedBy: "legacy" } : {}),
    ...(next.recovered ? { recoveredAt: stamp, recoveredFromState: typeof current?.state === "string" ? current.state : null } : {}),
    ...(next.settled ? { settledAt: stamp } : {}),
    ...(current && next.departedByLegacyWrite && next.state === D.STATE.ON_TRIP && current.state !== D.STATE.ON_TRIP
      ? { departedAt: stamp, departedByUid: null, departedBy: "legacy-client-write" }
      : {}),
    ...(next.dissolved ? { departedAt: null, departedByUid: null, settledAt: null } : {}),
  }, { merge: true });

  if (tripId) {
    const status = next.state === D.STATE.FORMING ? "forming" : next.state === D.STATE.ON_TRIP ? "departed" : "settled";
    tx.set(db.collection(D.RIDER_TRIPS).doc(tripId), {
      riderUid,
      status,
      orderIds: next.orderIds,
      ...(next.settled ? { settledAt: stamp } : {}),
      ...(next.newTrip
        ? { source: !current ? "classification" : next.recovered ? "recovery" : "legacy-client-write", createdAt: stamp }
        : {}),
      updatedAt: stamp,
    }, { merge: true });
  }
  // A forming trip that never left is closed — only if it is this Rider's.
  if (next.dissolved && typeof current?.tripId === "string" && current.tripId && view.trip?.riderUid === riderUid) {
    tx.set(db.collection(D.RIDER_TRIPS).doc(current.tripId), { status: "dissolved", orderIds: [], updatedAt: stamp }, { merge: true });
  }
  for (const id of next.adoptOrderIds ?? []) {
    if (tripId && view.byId.get(id)?.dispatchTripId !== tripId) {
      tx.update(db.collection(ORDERS).doc(id), { dispatchTripId: tripId, updatedAt: stamp });
    }
  }
  return {
    riderUid,
    state: next.state,
    tripId,
    orderIds: next.orderIds,
    heldOrderIds: next.heldOrderIds,
    lastConfirmedTripId: current?.lastConfirmedTripId ?? null,
  };
}

/**
 * Inside a callable's transaction: read the Rider, re-derive their state from
 * their orders, write any correction, and return the state to decide on.
 * Fails closed when an assigned order's status cannot be placed.
 */
async function settle(tx, db, FieldValue, riderUid, extraOrderIds = []) {
  const view = await readRiderView(tx, db, riderUid, extraOrderIds);
  const next = D.reconcile({ riderUid, current: view.state, memberOrders: view.byId, riderOrders: view.riderOrders, trip: view.trip });
  if (next.unknown) {
    throw new PolicyError(
      "rider-state-unknown",
      "This rider's orders could not be checked, so no trip decision was made. Ask an Admin to review the rider's orders.",
      { orderIds: next.orderIds }
    );
  }
  const cur = next.unchanged ? fromStored(riderUid, view.state) : applyNext(tx, db, FieldValue, view, riderUid, next);
  return { view, cur };
}

/** Belt and braces: the orders themselves say whether the Rider is on the road. */
const onTheRoad = (view) => view.riderOrders.filter(({ data }) => D.DEPARTED.includes(data?.status)).map((o) => o.id);

const firstText = (...values) => values.find((v) => typeof v === "string" && v.trim() !== "")?.trim() ?? null;

// ------------------------------------------------------------------ assign

async function assignRiderToOrder({ db, FieldValue, uid, email = null, payload, now }) {
  await loadDispatchActor(db, uid);
  const orderId = requestId(payload?.orderId, "That order could not be identified.");
  const riderUid = requestId(payload?.riderUid, "Please select an available rider.");
  // Commit any correction first, so a refusal below still repairs a stale state.
  await reconcileRider({ db, FieldValue, riderUid });

  return runTripTransaction(db, async (tx) => {
    const orderRef = db.collection(ORDERS).doc(orderId);
    const orderSnap = await tx.get(orderRef);
    const riderSnap = await tx.get(db.collection(USERS).doc(riderUid));
    const { view, cur } = await settle(tx, db, FieldValue, riderUid);

    if (!orderSnap.exists) throw new PolicyError("order-not-found", "That order no longer exists.");
    const order = orderSnap.data();

    // Repeat of a call that already succeeded: same order, same Rider, same trip.
    if (
      cur.state === D.STATE.FORMING &&
      order.assignedRiderId === riderUid &&
      D.PRE_DEPARTURE.includes(order.status) &&
      typeof order.dispatchTripId === "string" &&
      order.dispatchTripId === cur.tripId
    ) {
      return { orderId, riderUid, tripId: cur.tripId, replayed: true };
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

    const allowed = D.assignmentAllowed(cur.state);
    if (!allowed.ok) throw new PolicyError(allowed.code, allowed.message, { riderState: cur.state });
    if (onTheRoad(view).length > 0) {
      throw new PolicyError("rider-on-trip", D.assignmentAllowed(D.STATE.ON_TRIP).message, { riderState: D.STATE.ON_TRIP });
    }

    const forming = cur.state === D.STATE.FORMING;
    const tripId = forming ? cur.tripId : newTripId(db);
    const members = forming ? [...new Set([...cur.orderIds, orderId])].sort() : [orderId];
    if (members.length > MAX_TRIP_ORDERS) {
      throw new PolicyError("trip-full", `A trip can carry at most ${MAX_TRIP_ORDERS} orders. Dispatch this rider first.`);
    }

    // ---- writes
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
      tx.set(view.stateRef, { state: D.STATE.FORMING, tripId, orderIds: members, heldOrderIds: [], updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      tx.set(tripRef, { riderUid, orderIds: members, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
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
        ...(cur.lastConfirmedTripId ? { lastConfirmedTripId: cur.lastConfirmedTripId } : {}),
      }, { merge: true });
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
  await reconcileRider({ db, FieldValue, riderUid });

  return runTripTransaction(db, async (tx) => {
    // Reserved batches, read FIRST: settle() below may write a corrected trip
    // state, and every read must come before a transaction's first write.
    const reservedBatches = await readReservedBatches(tx, db, requested);
    // The orders the caller named are read too (a replay after the trip moved on).
    const { view, cur } = await settle(tx, db, FieldValue, riderUid, requested);

    if (cur.state !== D.STATE.FORMING) {
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
        cur.state === D.STATE.AVAILABLE ? "trip-not-forming" : "rider-on-trip",
        cur.state === D.STATE.AVAILABLE
          ? "This rider has no orders waiting to be dispatched. Refresh cargo loading."
          : "This rider has already left on a trip or is returning to the hub. Refresh cargo loading."
      );
    }
    if (onTheRoad(view).length > 0) {
      throw new PolicyError("rider-on-trip", "This rider still has orders out for delivery. Refresh cargo loading.");
    }
    if (expectedTripId && cur.tripId !== expectedTripId) {
      throw new PolicyError("trip-changed", "This rider's trip changed. Refresh cargo loading.");
    }

    // The live trip: every order with this Rider waiting to leave.
    const live = cur.orderIds.filter((id) => {
      const o = view.byId.get(id);
      return o && o.assignedRiderId === riderUid && D.PRE_DEPARTURE.includes(o.status);
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
      // A batch can expire between reservation and departure (a later
      // delivery, a reschedule, a corrected expiry): nothing leaves with it.
      assertBatchesCover(reservedBatches.get(id) ?? [], usableThrough(o, now), {
        action: `${firstText(o.orderNumber) ?? "An order"} cannot be dispatched with it. Cancel the order and place it again, or ask an Admin to review the stock.`,
      });
    }

    // ---- writes
    for (const id of live) {
      const o = view.byId.get(id);
      tx.update(db.collection(ORDERS).doc(id), {
        // A legacy order confirmed before the custody audit existed is stamped
        // as it leaves; an existing audit is never touched.
        ...(hasLoadingAudit(o)
          ? {}
          : { loadedAt: FieldValue.serverTimestamp(), loadedByUid: uid, ...(email ? { loadedByEmail: email } : {}) }),
        status: "in_transit",
        dispatchTripId: cur.tripId,
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
      tripId: cur.tripId,
      orderIds: live,
      heldOrderIds: [],
      departedAt: FieldValue.serverTimestamp(),
      departedByUid: uid,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.set(db.collection(D.RIDER_TRIPS).doc(cur.tripId), {
      riderUid,
      status: "departed",
      orderIds: live,
      departedAt: FieldValue.serverTimestamp(),
      departedByUid: uid,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { riderUid, tripId: cur.tripId, dispatchedOrderIds: live, replayed: false };
  });
}

// ------------------------------------------------------------------ return to hub

async function confirmRiderReturnToHub({ db, FieldValue, uid, payload }) {
  await loadDispatchActor(db, uid);
  const riderUid = requestId(payload?.riderUid, "Rider is required.");
  const tripId = requestId(payload?.tripId, "That trip could not be identified.");
  await reconcileRider({ db, FieldValue, riderUid });

  return runTripTransaction(db, async (tx) => {
    const { view, cur } = await settle(tx, db, FieldValue, riderUid);
    return confirmReturnInTransaction(tx, { db, FieldValue, uid, riderUid, tripId, view, cur });
  });
}

/**
 * The return decision and its writes, after `settle` (or the recovery's own
 * reads and re-derivation) in the same transaction. Writes only — the caller
 * has finished reading. Shared by the Dispatcher callable and the Admin
 * recovery (riderRecoveryOps.js), so both confirm a return identically.
 */
function confirmReturnInTransaction(tx, { db, FieldValue, uid, riderUid, tripId, view, cur }) {
  if (cur.lastConfirmedTripId === tripId && cur.tripId !== tripId) {
    return { riderUid, tripId, state: cur.state, replayed: true };
  }
  if (cur.tripId !== tripId) {
    throw new PolicyError("trip-changed", "This rider's trip changed. Refresh and try again.");
  }
  if (cur.state !== D.STATE.RETURNING) {
    throw new PolicyError(
      "trip-not-settled",
      cur.state === D.STATE.ON_TRIP
        ? "This rider still has orders out for delivery. Confirm their return once every order is finished."
        : "This rider is not returning from a trip."
    );
  }
  // From the orders, not the document: nothing may still be on the road.
  if (onTheRoad(view).length > 0) {
    throw new PolicyError("trip-not-settled", "This rider still has orders out for delivery.");
  }
  // Orders assigned while the Rider was out (held) become the next trip.
  const held = cur.heldOrderIds.filter((id) => {
    const o = view.byId.get(id);
    return o && o.assignedRiderId === riderUid && D.PRE_DEPARTURE.includes(o.status);
  });
  const nextTripId = held.length > 0 ? newTripId(db) : null;

  // ---- writes
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
}

// ------------------------------------------------------------------ reconcile (trigger + repair)

const TRIP_FIELDS = ["status", "assignedRiderId", "dispatchTripId"];

/** Did this write change anything a trip depends on? Location fixes etc. do not. */
function tripRelevant(before, after) {
  if (!before || !after) return Boolean((before ?? after)?.assignedRiderId);
  return TRIP_FIELDS.some((f) => (before[f] ?? null) !== (after[f] ?? null));
}

/**
 * Bring one Rider's stored state in line with their orders, in one
 * transaction. Idempotent: writes nothing when they already agree. Never makes
 * a Rider available after a departure (riderDispatch.reconcile). An order with
 * an unplaceable status leaves the state untouched and is reported.
 */
async function reconcileRider({ db, FieldValue, riderUid }) {
  return runTripTransaction(db, async (tx) => {
    const view = await readRiderView(tx, db, riderUid);
    const next = D.reconcile({ riderUid, current: view.state, memberOrders: view.byId, riderOrders: view.riderOrders, trip: view.trip });
    const previousState = typeof view.state?.state === "string" ? view.state.state : null;
    if (next.unknown) return { riderUid, changed: false, unknown: true, orderIds: next.orderIds, state: previousState, previousState };
    if (next.unchanged) return { riderUid, changed: false, state: previousState, previousState };
    const cur = applyNext(tx, db, FieldValue, view, riderUid, next);
    return {
      riderUid,
      changed: true,
      state: cur.state,
      previousState,
      tripId: cur.tripId,
      recovered: Boolean(next.recovered),
      anomalies: next.anomalies ?? [],
    };
  });
}

async function reconcileRiderOnOrderWrite({ db, FieldValue, before, after }) {
  if (!tripRelevant(before, after)) return [];
  const riders = [...new Set([before?.assignedRiderId, after?.assignedRiderId].filter((v) => typeof v === "string" && v !== ""))];
  const results = [];
  for (const riderUid of riders) results.push(await reconcileRider({ db, FieldValue, riderUid }));
  return results;
}

/**
 * Repair: a Dispatcher or Admin re-derives the trip state of the Riders they
 * name (1–25), one transaction each — the same step the order-write trigger
 * runs, for a state a missed or failed trigger event left behind. It never
 * makes a Rider available after a departure (a finished trip becomes
 * returning_to_hub, to be confirmed as usual), never changes an order's status
 * or assignment, and refuses accounts that are not Riders.
 */
async function recheckRiderTripStates({ db, FieldValue, uid, payload }) {
  await loadDispatchActor(db, uid);
  const raw = payload?.riderUids;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_RECHECK_RIDERS) {
    throw new PolicyError("invalid-request", `Name between 1 and ${MAX_RECHECK_RIDERS} riders to re-check.`);
  }
  const riderUids = [...new Set(raw.map((v) => requestId(v, "A rider could not be identified.")))];
  const results = [];
  for (const riderUid of riderUids) {
    const user = await db.collection(USERS).doc(riderUid).get();
    if (!user.exists || user.data().role !== "rider") {
      results.push({ riderUid, changed: false, error: "not-a-rider" });
      continue;
    }
    const r = await reconcileRider({ db, FieldValue, riderUid });
    results.push({
      riderUid,
      changed: r.changed,
      state: r.state ?? null,
      previousState: r.previousState ?? null,
      ...(r.unknown ? { error: "rider-state-unknown", orderIds: r.orderIds } : {}),
      ...(r.recovered ? { recovered: true } : {}),
      anomalies: r.anomalies ?? [],
    });
  }
  return { results };
}

module.exports = {
  loadDispatchActor,
  assignRiderToOrder,
  finalizeRiderDispatch,
  confirmRiderReturnToHub,
  recheckRiderTripStates,
  reconcileRider,
  reconcileRiderOnOrderWrite,
  tripRelevant,
  // The Admin recovery (riderRecoveryOps.js) decides on the same state.
  applyNext,
  fromStored,
  onTheRoad,
  confirmReturnInTransaction,
  MAX_TRIP_ORDERS,
  MAX_RECHECK_RIDERS,
  // Exported for the retry tests.
  isTransientTransactionError,
  runTripTransaction,
  TRANSIENT_ATTEMPTS,
};
