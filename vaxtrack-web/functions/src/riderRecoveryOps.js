"use strict";

/**
 * Admin Rider recovery — the transactions (decisions in riderRecovery.js).
 *
 *   previewRiderRecovery  callable  READ-ONLY: the Rider's authoritative trip
 *                                   state, its orders (by order number), what
 *                                   each recovery would do or why it can't,
 *                                   and a `version` of everything it read.
 *   applyRiderRecovery    callable  confirm_return | qa_reset, with a reason and
 *                                   the preview's `version`. Re-reads the same
 *                                   documents in ONE transaction and refuses
 *                                   (`recovery-stale`) if any of them changed.
 *
 * Re-checking a Rider is the existing recheckRiderTripStates callable.
 *
 * The caller sends only the Rider, the action, the version and a reason. Order
 * ids, trip ids, statuses and custody all come from the documents read here.
 *
 * Idempotent: each applied recovery creates one audit record whose id is
 * derived from the action, the Rider and the preview version, read in the same
 * transaction. A repeat (or a concurrent duplicate, which Firestore serializes)
 * finds it and replays its result without writing anything.
 */

const crypto = require("node:crypto");
const { PolicyError, validateReason } = require("./policy");
const { routeFieldDeletes } = require("./orderRouteFields");
const { statusUpdatedByEmailValue } = require("./attribution");
const D = require("./riderDispatch");
const R = require("./riderRecovery");
const {
  applyNext,
  fromStored,
  confirmReturnInTransaction,
  runTripTransaction,
  MAX_TRIP_ORDERS,
} = require("./riderDispatchOps");

const ORDERS = "orders";
const USERS = "users";
const RETURNS = "inventoryReturns";
const NAVIGATION_SESSIONS = "riderNavigationSessions";
const RECOVERY_AUDITS = "riderRecoveryAudits";
const ACTIONS = Object.freeze(["confirm_return", "qa_reset"]);

function requestId(value, message) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.includes("/") || id.length > 300) throw new PolicyError("invalid-request", message);
  return id;
}

/** An approved Admin — recovery is not a Dispatcher action. */
async function loadAdmin(db, uid) {
  const snap = await db.collection(USERS).doc(uid).get();
  const user = snap.exists ? snap.data() : null;
  if (!user) throw new PolicyError("profile-missing", "Your account profile could not be found.");
  if (user.role !== "admin") throw new PolicyError("wrong-role", "Only an Admin can recover a rider.");
  if (user.status !== "approved") throw new PolicyError("not-approved", "Your account is not approved.");
  return user;
}

const validId = (id) => typeof id === "string" && id !== "" && !id.includes("/");
const stampOf = (snap) => (snap.exists && snap.updateTime ? `${snap.updateTime.seconds}.${snap.updateTime.nanoseconds}` : "missing");

/**
 * Everything a recovery decision reads, in one transaction. Reads only.
 * Returns the riderDispatchOps view shape plus the recovery's own inputs and a
 * `version`: a digest of every document read and its update time, so ANY write
 * to any of them between preview and apply is detected.
 */
async function readRecovery(tx, db, riderUid) {
  const stamps = [];
  const track = (snap) => {
    stamps.push(`${snap.ref.path}@${stampOf(snap)}`);
    return snap;
  };

  const riderSnap = track(await tx.get(db.collection(USERS).doc(riderUid)));
  const stateRef = db.collection(D.RIDER_DISPATCH_STATES).doc(riderUid);
  const stateSnap = track(await tx.get(stateRef));
  const state = stateSnap.exists ? stateSnap.data() : null;

  const q = await tx.get(db.collection(ORDERS).where("assignedRiderId", "==", riderUid));
  if (q.size > MAX_TRIP_ORDERS * 2) {
    throw new PolicyError("recovery-too-large", "This rider has too many orders to recover here. Ask a developer to review them.");
  }
  q.docs.forEach(track);
  const riderOrders = q.docs.map((d) => ({ id: d.id, data: d.data() }));
  const byId = new Map(riderOrders.map((o) => [o.id, o.data]));
  const memberIds = [...new Set([...(state?.orderIds ?? []), ...(state?.heldOrderIds ?? [])])].filter((id) => validId(id) && !byId.has(id));
  for (const id of memberIds.slice(0, MAX_TRIP_ORDERS)) {
    const s = track(await tx.get(db.collection(ORDERS).doc(id)));
    byId.set(id, s.exists ? s.data() : null);
  }

  let trip;
  if (validId(state?.tripId)) {
    const t = track(await tx.get(db.collection(D.RIDER_TRIPS).doc(state.tripId)));
    trip = t.exists ? t.data() : null;
  }
  // Older trips an assigned order still names (never the route optimizer's tripId).
  const referencedTrips = new Map();
  for (const { data } of riderOrders) {
    const tid = data?.dispatchTripId;
    if (validId(tid) && tid !== state?.tripId && !referencedTrips.has(tid) && referencedTrips.size < MAX_TRIP_ORDERS) {
      const t = track(await tx.get(db.collection(D.RIDER_TRIPS).doc(tid)));
      referencedTrips.set(tid, t.exists ? t.data() : null);
    }
  }
  const navSnap = track(await tx.get(db.collection(NAVIGATION_SESSIONS).doc(riderUid)));

  // Returns of every order involved (by order id; equality only, no index).
  const returnsByOrder = new Map();
  const involved = [...new Set([...riderOrders.map((o) => o.id), ...memberIds])].slice(0, MAX_TRIP_ORDERS * 2);
  for (const id of involved) {
    const rs = await tx.get(db.collection(RETURNS).where("orderId", "==", id));
    rs.docs.forEach(track);
    returnsByOrder.set(id, rs.docs.map((d) => ({ id: d.id, data: d.data() })));
  }

  const version = crypto.createHash("sha256").update(stamps.sort().join("\n")).digest("hex");
  return {
    view: { stateRef, state, riderOrders, byId, trip },
    rider: riderSnap.exists ? riderSnap.data() : null,
    navigation: navSnap.exists ? navSnap.data() : null,
    referencedTrips,
    returnsByOrder,
    version,
  };
}

/** The Rider's state as the orders make it (not written). */
function derive(riderUid, view) {
  const next = D.reconcile({ riderUid, current: view.state, memberOrders: view.byId, riderOrders: view.riderOrders, trip: view.trip });
  if (next.unknown) return { next, cur: null };
  const cur = next.unchanged
    ? fromStored(riderUid, view.state)
    : { riderUid, state: next.state, tripId: next.newTrip ? null : next.tripId ?? null, orderIds: next.orderIds ?? [], heldOrderIds: next.heldOrderIds ?? [] };
  return { next, cur };
}

function assess(riderUid, read, config) {
  const { view } = read;
  const { next, cur } = derive(riderUid, view);
  const qaReset = R.assessQaReset({
    riderUid,
    rider: read.rider,
    stored: view.state,
    trip: view.trip,
    next,
    riderOrders: view.riderOrders,
    memberOrders: view.byId,
    returnsByOrder: read.returnsByOrder,
    referencedTrips: read.referencedTrips,
    navigation: read.navigation,
    config,
  });
  const confirmReturn = R.assessConfirmReturn({ cur, riderOrders: view.riderOrders, unknown: Boolean(next.unknown) });
  return { next, cur, qaReset, confirmReturn };
}

/** Orders for the Admin: order numbers, statuses, custody — never raw ids in text. */
function describeOrders(riderUid, view, qaReset) {
  const members = new Set(view.state?.orderIds ?? []);
  const held = new Set(view.state?.heldOrderIds ?? []);
  const ids = [...new Set([...view.riderOrders.map((o) => o.id), ...members, ...held])].sort();
  return ids.map((id) => {
    const o = view.byId.get(id) ?? null;
    const label = R.orderLabel(o);
    const withRider = o?.assignedRiderId === riderUid;
    const active = withRider && (D.PRE_DEPARTURE.includes(o?.status) || D.DEPARTED.includes(o?.status));
    const blocker = qaReset.blockers.find((b) => b.orderNumber === label) ?? null;
    return {
      orderId: id,
      orderNumber: label,
      status: o?.status ?? null,
      statusLabel: R.STATUS_LABELS[o?.status] ?? (o ? "Unknown status" : "Order not found"),
      onTrip: members.has(id),
      held: held.has(id),
      assignedToRider: withRider,
      active,
      terminal: !active,
      custody: R.custodyOf(o),
      ...(blocker ? { blocker: { code: blocker.code, message: blocker.message } } : {}),
    };
  });
}

// ------------------------------------------------------------------ preview

async function previewRiderRecovery({ db, uid, payload, config }) {
  await loadAdmin(db, uid);
  const riderUid = requestId(payload?.riderUid, "Rider is required.");
  const read = await db.runTransaction((tx) => readRecovery(tx, db, riderUid), { readOnly: true });
  if (!read.rider || read.rider.role !== "rider") {
    throw new PolicyError("not-a-rider", "That account is not a rider.");
  }
  const { view } = read;
  const { next, cur, qaReset, confirmReturn } = assess(riderUid, read, config);
  const stored = view.state;
  return {
    riderUid,
    riderName: firstText(read.rider.fullName, read.rider.name, read.rider.displayName),
    version: read.version,
    stored: stored
      ? { state: stored.state ?? null, tripId: stored.tripId ?? null, departed: present(stored.departedAt) }
      : { state: null, tripId: null, departed: false },
    derived: next.unknown
      ? { state: null, tripId: null, unknown: true }
      : { state: cur.state, tripId: cur.tripId, unknown: false, differsFromStored: !next.unchanged },
    trip: view.trip === undefined ? null : view.trip ? { status: view.trip.status ?? null, departed: present(view.trip.departedAt) || view.trip.status === "departed" } : { status: null, missing: true, departed: false },
    navigation: { active: Boolean(read.navigation && read.navigation.state === "navigating" && !present(read.navigation.endedAt)) },
    orders: describeOrders(riderUid, view, qaReset),
    actions: {
      recheck: { available: true, needed: !next.unknown && !next.unchanged },
      confirmReturn,
      qaReset: {
        enabled: qaReset.enabled,
        available: qaReset.available,
        noop: qaReset.noop,
        blockers: qaReset.blockers,
        requeueOrderNumbers: qaReset.requeueOrderIds.map((id) => R.orderLabel(view.byId.get(id))),
      },
    },
  };
}

// ------------------------------------------------------------------ apply

async function applyRiderRecovery({ db, FieldValue, uid, email = null, payload, config }) {
  const admin = await loadAdmin(db, uid);
  const riderUid = requestId(payload?.riderUid, "Rider is required.");
  const action = payload?.action;
  if (!ACTIONS.includes(action)) throw new PolicyError("invalid-request", "Choose a recovery action.");
  const version = typeof payload?.version === "string" && /^[a-f0-9]{64}$/.test(payload.version) ? payload.version : null;
  if (!version) throw new PolicyError("invalid-request", "Preview the rider's recovery again before applying it.");
  const reason = validateReason(payload?.reason, "reason for this recovery");
  // Fail closed BEFORE reading anything: production, an unlisted project, or
  // the switch off.
  if (action === "qa_reset" && !config?.enabled) {
    throw new PolicyError("qa-reset-disabled", "QA trip reset is turned off for this project.");
  }

  const auditRef = db.collection(RECOVERY_AUDITS).doc(`${action}_${riderUid}_${version}`);

  return runTripTransaction(db, async (tx) => {
    // ---- reads
    const audit = await tx.get(auditRef);
    if (audit.exists) {
      const a = audit.data();
      return { action, riderUid, state: a.after?.state ?? null, affectedOrderNumbers: (a.affectedOrders ?? []).map((o) => o.orderNumber), replayed: true };
    }
    const read = await readRecovery(tx, db, riderUid);
    if (!read.rider || read.rider.role !== "rider") throw new PolicyError("not-a-rider", "That account is not a rider.");
    if (read.version !== version) {
      throw new PolicyError("recovery-stale", "This rider's trip or orders changed since the preview. Review the latest details and try again.");
    }
    const { view } = read;
    const { next, cur, qaReset, confirmReturn } = assess(riderUid, read, config);
    if (next.unknown) {
      throw new PolicyError("rider-state-unknown", "Some of this rider's orders could not be checked, so nothing was changed.", { orderNumbers: (next.orderIds ?? []).map((id) => R.orderLabel(view.byId.get(id))) });
    }
    const before = snapshotOf(view.state, cur);
    const auditBase = {
      action,
      riderUid,
      riderName: firstText(read.rider.fullName, read.rider.name, read.rider.displayName),
      actorUid: uid,
      actorRole: admin.role,
      ...(email ? { actorEmail: email } : {}),
      reason,
      previewVersion: version,
      projectId: config?.projectId ?? null,
      before,
      createdAt: FieldValue.serverTimestamp(),
    };

    // ---- confirm the return (the Dispatcher's decision, unchanged)
    if (action === "confirm_return") {
      if (!confirmReturn.available) throw new PolicyError("trip-not-settled", confirmReturn.message);
      const settledCur = next.unchanged ? cur : applyNext(tx, db, FieldValue, view, riderUid, next);
      const members = (cur.orderIds ?? []).map((id) => ({
        orderId: id,
        orderNumber: R.orderLabel(view.byId.get(id)),
        status: view.byId.get(id)?.status ?? null,
      }));
      const result = confirmReturnInTransaction(tx, { db, FieldValue, uid, riderUid, tripId: settledCur.tripId, view, cur: settledCur });
      tx.create(auditRef, {
        ...auditBase,
        tripId: settledCur.tripId,
        after: { state: result.state, tripId: result.nextTripId ?? null },
        affectedOrders: members,
      });
      return { action, riderUid, state: result.state, affectedOrderNumbers: members.map((m) => m.orderNumber), replayed: false };
    }

    // ---- QA reset (staging/demo only)
    if (qaReset.blockers.length > 0) {
      throw new PolicyError(
        "recovery-blocked",
        `This rider can't be reset: ${qaReset.blockers.map((b) => b.message).join(" ")}`,
        { blockers: qaReset.blockers }
      );
    }
    if (qaReset.noop) {
      return { action, riderUid, state: D.STATE.AVAILABLE, affectedOrderNumbers: [], changed: false, replayed: false };
    }
    const stamp = FieldValue.serverTimestamp();
    const affected = [];
    for (const id of qaReset.requeueOrderIds) {
      const o = view.byId.get(id);
      affected.push({ orderId: id, orderNumber: R.orderLabel(o), fromStatus: o.status, toStatus: "pending_dispatch", previousTripId: o.dispatchTripId ?? null });
      tx.update(db.collection(ORDERS).doc(id), {
        status: "pending_dispatch",
        previousAssignedRiderId: riderUid,
        assignedRiderId: null,
        assignedRiderName: null,
        assignedRiderPhone: null,
        dispatchTripId: FieldValue.delete(),
        // A route drawn from this rider's position is stale for the next one.
        ...routeFieldDeletes(o, FieldValue),
        qaResetAt: stamp,
        qaResetByUid: uid,
        statusUpdatedAt: stamp,
        statusUpdatedByUid: uid,
        statusUpdatedByEmail: statusUpdatedByEmailValue(email, FieldValue),
        updatedAt: stamp,
      });
    }
    for (const tid of qaReset.dissolveTripIds) {
      tx.set(db.collection(D.RIDER_TRIPS).doc(tid), {
        status: "dissolved",
        orderIds: [],
        dissolvedBy: "qa-reset",
        dissolvedAt: stamp,
        dissolvedByUid: uid,
        recoveryAuditId: auditRef.id,
        updatedAt: stamp,
      }, { merge: true });
    }
    tx.set(view.stateRef, {
      riderUid,
      state: D.STATE.AVAILABLE,
      tripId: null,
      orderIds: [],
      heldOrderIds: [],
      departedAt: null,
      departedByUid: null,
      settledAt: null,
      qaResetAt: stamp,
      qaResetByUid: uid,
      recoveryAuditId: auditRef.id,
      updatedAt: stamp,
    }, { merge: true });
    tx.create(auditRef, {
      ...auditBase,
      tripId: before.tripId,
      dissolvedTripIds: qaReset.dissolveTripIds,
      after: { state: D.STATE.AVAILABLE, tripId: null },
      affectedOrders: affected,
    });
    return { action, riderUid, state: D.STATE.AVAILABLE, affectedOrderNumbers: affected.map((a) => a.orderNumber), changed: true, replayed: false };
  });
}

const present = (v) => v !== undefined && v !== null && v !== "";
const firstText = (...values) => values.find((v) => typeof v === "string" && v.trim() !== "")?.trim() ?? null;

function snapshotOf(stored, cur) {
  return {
    storedState: stored?.state ?? null,
    state: cur?.state ?? null,
    tripId: cur?.tripId ?? (typeof stored?.tripId === "string" ? stored.tripId : null),
    orderIds: cur?.orderIds ?? [],
    heldOrderIds: cur?.heldOrderIds ?? [],
  };
}

module.exports = {
  previewRiderRecovery,
  applyRiderRecovery,
  RECOVERY_AUDITS,
};
