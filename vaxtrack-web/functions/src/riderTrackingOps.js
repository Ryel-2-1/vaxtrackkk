"use strict";

/**
 * Rider tracking — the Firestore transaction layer over riderTracking.js.
 *
 * Every function is a server-side (Admin SDK) handler for a trigger and is
 * written to be RETRY-SAFE: triggers run at least once, so each handler
 * re-reads the current documents inside a transaction and decides from them.
 * A replayed location write is ignored by the state machine (capture time not
 * newer); deviation events have deterministic ids and are created only when
 * absent; an alert is created at most once per session and only re-opened or
 * resolved by state transitions.
 *
 * Never written here: orders, inventory, reservations, invoices, prices.
 * Written here: riderDeviationStates, routeDeviationEvents, alerts
 * (route_deviation only), riderLocationViewers, and the ended state of a
 * riderNavigationSessions doc whose order stopped being navigable.
 */

const T = require("./riderTracking");

const C = Object.freeze({
  LOCATIONS: "riderLocations",
  SESSIONS: "riderNavigationSessions",
  STATES: "riderDeviationStates",
  EVENTS: "routeDeviationEvents",
  VIEWERS: "riderLocationViewers",
  ALERTS: "alerts",
  ORDERS: "orders",
});

const withServerTimes = (FieldValue, data, fields) => {
  const out = { ...data };
  for (const f of fields) out[f] = FieldValue.serverTimestamp();
  return out;
};

/** The alert context for a session (display fields only from the order). */
function alertContext({ riderUid, sessionId, orderId, order }) {
  return {
    riderUid,
    sessionId,
    orderId,
    orderNumber: typeof order?.orderNumber === "string" ? order.orderNumber : null,
    riderName: typeof order?.assignedRiderName === "string" ? order.assignedRiderName : null,
  };
}

/**
 * Close the deviation state of a session inside a transaction: resolve its open
 * alert (if any) and record a session_closed event. Reads must already have
 * been made by the caller (`existingAlert`).
 */
function closeStateWrites({ tx, db, FieldValue, stateRef, state, reason, existingAlert, closedEventExists, writeState = true }) {
  if (state?.openAlertId && existingAlert) {
    const plan = T.planAlertWrite({
      existing: existingAlert,
      transition: { type: "session_closed", reason },
      context: { orderId: state.orderId, riderUid: state.riderUid, sessionId: state.sessionId },
    });
    if (plan.action === "resolve") {
      tx.update(db.collection(C.ALERTS).doc(state.openAlertId), withServerTimes(FieldValue, plan.data, plan.serverTimestamps));
    }
  }
  if (state?.phase === "deviating" && state.episode >= 1 && !closedEventExists) {
    const eventId = T.deviationEventId({ sessionId: state.sessionId, episode: state.episode, type: "session_closed" });
    tx.create(db.collection(C.EVENTS).doc(eventId), {
      eventId,
      type: "session_closed",
      reason,
      riderUid: state.riderUid,
      orderId: state.orderId,
      sessionId: state.sessionId,
      episode: state.episode,
      createdAt: FieldValue.serverTimestamp(),
    });
  }
  // writeState=false when the caller writes a fresh state for a new session in
  // the same transaction (one write per document).
  if (!writeState) return;
  tx.set(stateRef, {
    ...state,
    sessionState: "ended",
    endReason: reason,
    phase: "on_route",
    pendingOffSinceMs: null,
    pendingReturnSinceMs: null,
    openAlertId: null,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

async function readCloseInputs(tx, db, state) {
  const existingAlert = state?.openAlertId ? await tx.get(db.collection(C.ALERTS).doc(state.openAlertId)) : null;
  let closedEventExists = true;
  if (state?.phase === "deviating" && state.episode >= 1) {
    const eventId = T.deviationEventId({ sessionId: state.sessionId, episode: state.episode, type: "session_closed" });
    closedEventExists = (await tx.get(db.collection(C.EVENTS).doc(eventId))).exists;
  }
  return { existingAlert: existingAlert?.exists ? existingAlert.data() : null, closedEventExists };
}

/** A fresh server state for a navigation session. */
function newState({ riderUid, session, route }) {
  return {
    ...T.initialDeviationState(),
    riderUid,
    sessionId: session.sessionId,
    orderId: session.orderId,
    sessionState: "navigating",
    sessionStartedAtMs: T.millisOf(session.startedAt),
    routeStatus: route.available ? "available" : "unavailable",
    routeUnavailableReason: route.available ? null : route.reason,
    routeSource: route.source,
    routeFingerprint: route.fingerprint,
    openAlertId: null,
    endReason: null,
  };
}

/**
 * Capture time of the rider's previous reported fix — the prior version of the
 * location document, delivered with the trigger — for the continuity check.
 * Null when there was none or tracking had ended (that is a gap).
 */
function previousSampleAtMs(previous) {
  if (!previous || previous.trackingState !== "active") return null;
  if (!T.isValidCoordinate(previous.latitude, previous.longitude)) return null;
  const captured = T.millisOf(previous.capturedAt);
  const updated = T.millisOf(previous.updatedAt);
  if (captured === null) return null;
  return updated !== null ? Math.min(captured, updated) : captured;
}

/**
 * A rider's riderLocations doc was written: advance the deviation state of the
 * active navigation session (if any). Returns a summary for logging.
 *
 * Writes happen only on a meaningful change: a new or replaced session or
 * route, a route becoming (un)available, or a deviation transition (a timer
 * starting, stopping or restarting after a gap, a phase change). An ordinary
 * sample that changes nothing performs reads only.
 *
 * `previous` is the location document before this write (continuity).
 */
async function processLocationWrite({ db, FieldValue, riderUid, location, previous = null }) {
  const sessionRef = db.collection(C.SESSIONS).doc(riderUid);
  const stateRef = db.collection(C.STATES).doc(riderUid);
  const locationRef = db.collection(C.LOCATIONS).doc(riderUid);
  return db.runTransaction(async (tx) => {
    const sessionSnap = await tx.get(sessionRef);
    const session = sessionSnap.exists ? sessionSnap.data() : null;
    if (!session || session.state !== "navigating" || session.riderUid !== riderUid) {
      return { evaluated: false, reason: "not_navigating" };
    }
    // Only the LATEST location is evaluated. Trigger delivery is not ordered:
    // an older write's event arriving late is skipped (the rules already make
    // stored capture times strictly increasing).
    const currentSnap = await tx.get(locationRef);
    const currentAt = currentSnap.exists ? T.millisOf(currentSnap.data().capturedAt) : null;
    const thisAt = T.millisOf(location?.capturedAt);
    if (currentAt !== null && thisAt !== null && currentAt > thisAt) {
      return { evaluated: false, reason: "superseded" };
    }
    const stateSnap = await tx.get(stateRef);
    let state = stateSnap.exists ? stateSnap.data() : null;
    const orderSnap = await tx.get(db.collection(C.ORDERS).doc(session.orderId));
    const order = orderSnap.exists ? orderSnap.data() : null;
    const route = T.routeForOrder(order);

    // A state left over from an earlier session is closed first.
    let staleClose = null;
    if (state && state.sessionId !== session.sessionId && state.sessionState === "navigating") {
      staleClose = { state, ...(await readCloseInputs(tx, db, state)) };
    }

    const endReason = T.sessionEndReasonForOrder(order, riderUid);
    if (endReason) {
      const closeInputs = state && state.sessionId === session.sessionId ? await readCloseInputs(tx, db, state) : null;
      if (staleClose) closeStateWrites({ tx, db, FieldValue, stateRef, reason: "replaced", ...staleClose });
      tx.update(sessionRef, { state: "ended", endReason, endedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      if (closeInputs) closeStateWrites({ tx, db, FieldValue, stateRef, state, reason: endReason, ...closeInputs });
      return { evaluated: false, reason: endReason };
    }

    let dirty = false;
    if (!state || state.sessionId !== session.sessionId) {
      state = newState({ riderUid, session, route });
      dirty = true;
    }
    const writeIfDirty = () => {
      if (staleClose) closeStateWrites({ tx, db, FieldValue, stateRef, reason: "replaced", writeState: false, ...staleClose });
      if (dirty) tx.set(stateRef, { ...state, updatedAt: FieldValue.serverTimestamp() });
    };

    if (!route.available) {
      if (state.routeStatus !== "unavailable" || state.routeUnavailableReason !== route.reason || state.routeFingerprint !== null) {
        state = { ...state, routeStatus: "unavailable", routeUnavailableReason: route.reason, routeSource: null, routeFingerprint: null };
        dirty = true;
      }
      writeIfDirty();
      return { evaluated: false, reason: "no_route", wrote: dirty };
    }
    if (state.routeFingerprint !== route.fingerprint || state.routeStatus !== "available") {
      // A replaced route never creates or resolves a deviation by itself: only
      // the UNCONFIRMED timers restart against the new route.
      state = { ...state, routeStatus: "available", routeUnavailableReason: null, routeSource: route.source, routeFingerprint: route.fingerprint, pendingOffSinceMs: null, pendingReturnSinceMs: null };
      dirty = true;
    }

    const parsed = T.sampleFromLocation(location);
    if (!parsed.ok) {
      writeIfDirty();
      return { evaluated: false, reason: parsed.reason, wrote: dirty };
    }
    const result = T.evaluateDeviation({
      state,
      sample: parsed.sample,
      route: route.points,
      previousSampleAtMs: previousSampleAtMs(previous),
      notBeforeMs: T.millisOf(session.startedAt),
    });
    if (result.changed) {
      state = { ...state, ...result.state };
      dirty = true;
    }

    // ---- remaining reads (all before any write) ----
    let eventRef = null;
    let eventExists = true;
    let alertRef = null;
    let existingAlert = null;
    const context = alertContext({ riderUid, sessionId: session.sessionId, orderId: session.orderId, order });
    if (result.event) {
      const eventId = T.deviationEventId({ sessionId: session.sessionId, episode: result.state.episode, type: result.event.type });
      eventRef = db.collection(C.EVENTS).doc(eventId);
      eventExists = (await tx.get(eventRef)).exists;
      alertRef = db.collection(C.ALERTS).doc(T.deviationAlertId(context));
      const alertSnap = await tx.get(alertRef);
      existingAlert = alertSnap.exists ? alertSnap.data() : null;
    }

    // ---- writes ----
    if (result.event) {
      if (!eventExists) {
        tx.create(eventRef, {
          eventId: eventRef.id,
          type: result.event.type,
          riderUid,
          orderId: session.orderId,
          sessionId: session.sessionId,
          episode: result.state.episode,
          distanceMeters: result.event.distanceMeters,
          sinceMs: result.event.sinceMs,
          atMs: result.event.atMs,
          latitude: parsed.sample.lat,
          longitude: parsed.sample.lng,
          accuracyMeters: parsed.sample.accuracyMeters,
          routeSource: route.source,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      const plan = T.planAlertWrite({ existing: existingAlert, transition: result.event, context });
      const data = withServerTimes(FieldValue, plan.data, plan.serverTimestamps);
      if (plan.action === "create") tx.set(alertRef, data);
      else if (plan.action === "reopen" || plan.action === "resolve") tx.update(alertRef, data);
      state = { ...state, openAlertId: result.event.type === "deviated" ? alertRef.id : null };
    }
    writeIfDirty();
    return { evaluated: true, event: result.event?.type ?? null, ignored: result.ignored, wrote: dirty };
  });
}

/**
 * A rider's riderNavigationSessions doc changed: a new or replaced session gets
 * a fresh state (closing the previous one); an ended or deleted session closes
 * its state and resolves any open alert.
 */
async function handleSessionWrite({ db, FieldValue, riderUid, after }) {
  const stateRef = db.collection(C.STATES).doc(riderUid);
  return db.runTransaction(async (tx) => {
    const stateSnap = await tx.get(stateRef);
    const state = stateSnap.exists ? stateSnap.data() : null;
    const navigating = after && after.state === "navigating" && after.riderUid === riderUid;
    let order = null;
    if (navigating) {
      const orderSnap = await tx.get(db.collection(C.ORDERS).doc(after.orderId));
      order = orderSnap.exists ? orderSnap.data() : null;
    }
    const closeOld = state && state.sessionState === "navigating" && (!navigating || state.sessionId !== after.sessionId);
    const closeInputs = closeOld ? await readCloseInputs(tx, db, state) : null;

    if (closeOld) {
      const reason = navigating ? "replaced" : after?.endReason || (after ? "rider_stopped" : "session_deleted");
      const replacing = navigating && state.sessionId !== after.sessionId;
      closeStateWrites({ tx, db, FieldValue, stateRef, state, reason, writeState: !replacing, ...closeInputs });
    }
    if (navigating && (!state || state.sessionId !== after.sessionId)) {
      tx.set(stateRef, { ...newState({ riderUid, session: after, route: T.routeForOrder(order) }), updatedAt: FieldValue.serverTimestamp() });
      return { started: after.sessionId, closed: closeOld ? state.sessionId : null };
    }
    return { started: null, closed: closeOld ? state.sessionId : null };
  });
}

/**
 * Recompute the Med Rep visibility index of one rider from the orders assigned
 * to them, inside a transaction (so concurrent order writes converge). Writes
 * only when it changed; deletes the index when nobody but staff may look.
 */
async function syncRiderVisibility({ db, FieldValue, riderUid }) {
  const viewerRef = db.collection(C.VIEWERS).doc(riderUid);
  return db.runTransaction(async (tx) => {
    const ordersSnap = await tx.get(db.collection(C.ORDERS).where("assignedRiderId", "==", riderUid));
    const current = await tx.get(viewerRef);
    const { viewerUids, activeOrderIds } = T.viewersForRider(
      riderUid,
      ordersSnap.docs.map((d) => ({ id: d.id, data: d.data() }))
    );
    const prev = current.exists ? current.data() : null;
    const same = prev && JSON.stringify(prev.viewerUids) === JSON.stringify(viewerUids) &&
      JSON.stringify(prev.activeOrderIds) === JSON.stringify(activeOrderIds);
    if (same) return { changed: false, viewerUids };
    if (viewerUids.length === 0 && activeOrderIds.length === 0) {
      if (current.exists) tx.delete(viewerRef);
      return { changed: current.exists, viewerUids };
    }
    tx.set(viewerRef, { riderUid, viewerUids, activeOrderIds, updatedAt: FieldValue.serverTimestamp() });
    return { changed: true, viewerUids };
  });
}

/**
 * An order was written: refresh visibility for the riders it involves, and end
 * a navigation session that points at it once it is no longer navigable for
 * that rider (completed, cancelled, failed, parked, unassigned, reassigned).
 */
async function handleOrderWrite({ db, FieldValue, orderId, before, after }) {
  const riders = T.ridersAffectedByOrderWrite(before, after);
  for (const riderUid of riders) await syncRiderVisibility({ db, FieldValue, riderUid });

  const ended = [];
  const candidates = [...new Set([before?.assignedRiderId, after?.assignedRiderId].filter((r) => typeof r === "string" && r))];
  for (const riderUid of candidates) {
    const reason = T.sessionEndReasonForOrder(after, riderUid);
    if (!reason) continue;
    const sessionRef = db.collection(C.SESSIONS).doc(riderUid);
    const closed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(sessionRef);
      const s = snap.exists ? snap.data() : null;
      if (!s || s.state !== "navigating" || s.orderId !== orderId) return false;
      tx.update(sessionRef, { state: "ended", endReason: reason, endedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      return true;
    });
    if (closed) ended.push({ riderUid, reason });
  }
  return { visibilitySynced: riders, sessionsEnded: ended };
}

/**
 * Retention (scheduled): delete current-location docs idle for 24 h, ended
 * sessions and their states after 24 h, and deviation events after 90 days.
 * Bounded per run; a later run continues. Returns counts.
 */
async function purgeExpiredTrackingData({ db, Timestamp, now, batchLimit = 300 }) {
  const cutoff = (ms) => Timestamp.fromMillis(now.getTime() - ms);
  const counts = { locations: 0, sessions: 0, states: 0, events: 0 };
  const purge = async (query, key) => {
    const snap = await query.limit(batchLimit).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    counts[key] += snap.size;
  };
  await purge(db.collection(C.LOCATIONS).where("updatedAt", "<", cutoff(T.RETENTION.locationMaxIdleMs)), "locations");
  // Ended sessions/states: filtered on time, then on state client-side (single-field queries only).
  for (const [col, key, stateField] of [[C.SESSIONS, "sessions", "state"], [C.STATES, "states", "sessionState"]]) {
    const snap = await db.collection(col).where("updatedAt", "<", cutoff(T.RETENTION.endedSessionMs)).limit(batchLimit).get();
    const ended = snap.docs.filter((d) => d.data()[stateField] === "ended");
    if (ended.length) {
      const batch = db.batch();
      ended.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      counts[key] += ended.length;
    }
  }
  // Old deviation events — except those of a session that is STILL navigating:
  // its alert may be unresolved, so that evidence is kept until it closes.
  const oldEvents = await db.collection(C.EVENTS).where("createdAt", "<", cutoff(T.RETENTION.deviationEventMs)).limit(batchLimit).get();
  const navigating = new Map();
  const expired = [];
  for (const d of oldEvents.docs) {
    const { riderUid, sessionId } = d.data();
    if (typeof riderUid === "string" && riderUid !== "") {
      if (!navigating.has(riderUid)) {
        const s = await db.collection(C.STATES).doc(riderUid).get();
        navigating.set(riderUid, s.exists && s.data().sessionState === "navigating" ? s.data().sessionId : null);
      }
      if (navigating.get(riderUid) === sessionId) continue;
    }
    expired.push(d.ref);
  }
  if (expired.length) {
    const batch = db.batch();
    expired.forEach((ref) => batch.delete(ref));
    await batch.commit();
    counts.events += expired.length;
  }
  return counts;
}

module.exports = {
  TRACKING_COLLECTIONS: C,
  processLocationWrite,
  handleSessionWrite,
  syncRiderVisibility,
  handleOrderWrite,
  purgeExpiredTrackingData,
};
