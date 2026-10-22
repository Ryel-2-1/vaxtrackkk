"use strict";

/**
 * Rider tracking — the Firestore transaction layer over riderTracking.js.
 *
 * Every function is a server-side (Admin SDK) handler for a trigger and is
 * written to be RETRY-SAFE: triggers run at least once, so each handler
 * re-reads the current documents inside a transaction and decides from them.
 * A replayed location write is recognised (its qualifying time is already on
 * record) and changes nothing; deviation events have deterministic ids and are
 * created only when absent; an alert is created at most once per session and
 * only re-opened or resolved by state transitions.
 *
 * ORDER: location triggers also arrive in ANY order. Only the latest stored
 * fix is ever evaluated, but every event — even a superseded one — records the
 * session's navigation evidence it carries (T.sessionEvidence), so a decision
 * made by one event never depends on another having run first. A session with
 * confirmed continuity (T.hasConfirmedContinuity) also carries its newest
 * qualifying fix on the session document itself, read inside the same
 * transaction — the only record that cannot be lost to delivery order.
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
    // Navigation evidence (T.sessionEvidence), monotonic: the newest tagged and
    // qualifying fix of this session the server has seen, and when complete
    // recording began — the session start, since this state is created with
    // the session (or by its first tagged fix, before which none was seen).
    lastTaggedFixAtMs: null,
    lastQualifyingFixAtMs: null,
    taggedHistorySinceMs: T.millisOf(session.startedAt),
  };
}

/**
 * A rider's riderLocations doc was written: advance the deviation state of the
 * active navigation session (if any). Returns a summary for logging.
 *
 * Only a fix the app TAGGED with the current session is evaluated
 * (T.navigationFixDecision). An untagged fix is never measured against a
 * route; it ENDS the session (resolving any open alert) only when the session
 * is stale — no tagged fix for SESSION_RULES.staleAfterMs, or none at all since
 * the start-up grace — and sharing ended always ends it.
 *
 * Writes: a new or replaced session or route, a route becoming (un)available,
 * a deviation transition, ending a session, and — whenever it moves forward —
 * the session's navigation evidence. That last one means every NEW tagged fix
 * writes the state once (about two writes a minute while navigating): recording
 * it is what lets an untagged fix whose event runs first, or a superseded event,
 * still know the session is alive. A replayed event writes nothing; an untagged
 * fix writes only when it carries evidence not yet on record.
 *
 * `previous` is the location document before this write (continuity: only a
 * previous fix of the same session counts).
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
    // Only the LATEST location is evaluated (the rules make stored capture
    // times strictly increasing); an older write's event arriving late is
    // superseded.
    const currentSnap = await tx.get(locationRef);
    const current = currentSnap.exists ? currentSnap.data() : null;
    const currentAt = current ? T.millisOf(current.capturedAt) : null;
    const thisAt = T.millisOf(location?.capturedAt);
    const superseded = currentAt !== null && thisAt !== null && currentAt > thisAt;
    const stateSnap = await tx.get(stateRef);
    let state = stateSnap.exists ? stateSnap.data() : null;
    const ownLiveState = Boolean(state) && state.sessionId === session.sessionId && state.sessionState === "navigating";

    // Everything this event knows about the session's navigation activity —
    // its own fix, the one before it, the stored current one — and what to
    // record (forward only). "Now" is the newest server write time in hand.
    const evidence = T.sessionEvidence({
      session,
      location,
      previous,
      current,
      state: ownLiveState ? state : null,
      nowMs: T.millisOf(current?.updatedAt) ?? T.millisOf(location?.updatedAt),
    });
    const recordEvidence = (reason, extra = {}) => {
      if (ownLiveState && Object.keys(evidence.patch).length > 0) {
        tx.set(stateRef, { ...state, ...evidence.patch, updatedAt: FieldValue.serverTimestamp() });
        return { evaluated: false, reason, wrote: true, ...extra };
      }
      return { evaluated: false, reason, ...extra };
    };

    if (superseded) {
      // Never evaluated, never ends a session, never alerts — but the
      // navigation evidence it carries (e.g. the tagged fix before an untagged
      // one) is recorded, so no later decision depends on delivery order.
      return recordEvidence("superseded");
    }

    const decision = T.navigationFixDecision({
      session,
      location,
      lastTaggedFixAtMs: evidence.lastTaggedFixAtMs,
      taggedHistorySinceMs: evidence.taggedHistorySinceMs,
      // A session with confirmed continuity (T.hasConfirmedContinuity) is
      // judged from qualifying fixes: its own confirmation, read with the
      // session in THIS transaction, and any qualifying fix the event sees.
      lastQualifyingFixAtMs: evidence.lastQualifyingFixAtMs,
    });

    if (decision.action === "ignore") return recordEvidence(decision.reason);

    if (decision.action === "end") {
      // The app stopped navigating this session without ending it (process
      // killed, reinstalled, signed out offline) or stopped sharing. End it and
      // close its server state; an open alert is resolved, never left behind.
      const own = Boolean(state) && state.sessionId === session.sessionId && state.sessionState === "navigating";
      const leftover = Boolean(state) && !own && state.sessionState === "navigating";
      const closeInputs = own || leftover ? await readCloseInputs(tx, db, state) : null;
      tx.update(sessionRef, { state: "ended", endReason: decision.reason, endedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      if (closeInputs) {
        closeStateWrites({ tx, db, FieldValue, stateRef, state, reason: own ? decision.reason : "replaced", ...closeInputs });
      }
      return { evaluated: false, reason: decision.reason, ended: true };
    }

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
    let ownEvidence = evidence;
    if (!state || state.sessionId !== session.sessionId) {
      state = newState({ riderUid, session, route });
      ownEvidence = T.sessionEvidence({ session, location, previous, current, state, nowMs: T.millisOf(current?.updatedAt) ?? T.millisOf(location?.updatedAt) });
      dirty = true;
    } else if (evidence.replay) {
      // This exact fix was evaluated before (a redelivered event): the state
      // already reflects it. Nothing is re-measured or rewritten.
      return { evaluated: false, event: null, ignored: "replay", wrote: false };
    }
    if (Object.keys(ownEvidence.patch).length > 0) {
      // Record this fix (and any older evidence) — forward only.
      state = { ...state, ...ownEvidence.patch };
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
      // Continuity from the last QUALIFYING fix of this session before this
      // one: an ordinary, inaccurate, late or other-session fix in between
      // neither bridges nor breaks it.
      previousSampleAtMs: ownEvidence.previousQualifyingAtMs,
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
 * its state and resolves any open alert. A write that only confirms a
 * navigation fix (T.isFixConfirmationOnly) changes nothing here and is skipped
 * without a transaction.
 */
async function handleSessionWrite({ db, FieldValue, riderUid, after, before = undefined }) {
  if (before !== undefined && T.isFixConfirmationOnly(before, after)) return { started: null, closed: null, skipped: "fix_confirmation" };
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
