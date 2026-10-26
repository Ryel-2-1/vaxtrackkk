"use strict";

/**
 * Stale rider location — the transactions (decisions in riderLocationStale.js).
 *
 *   evaluateRiderLocationStale  one Rider, from their documents NOW, in a transaction
 *   evaluateStaleLocationsRun   the bounded sweep, run by the 5-minute
 *                               evaluateDeliveryTiming schedule after its timing pass
 *   resolveStaleOnFix           the riderLocations trigger: one read; only a Rider
 *                               with an open stale incident is re-evaluated
 *
 * Every write is decided inside a transaction from the documents as stored
 * now — never from a trigger's event payload or a page the sweep read earlier —
 * so repeated, concurrent and out-of-order invocations converge: the alert id
 * is deterministic per Rider and server trip, created only when absent, and a
 * second run that finds nothing to change writes nothing.
 *
 * Reads per watched Rider per run: dispatch state, trip, location, watch
 * (+ the alert, + the Rider's name only when raising). Writes only on a change.
 */

const S = require("./riderLocationStale");

const STATES = "riderDispatchStates";
const TRIPS = "riderTrips";
const LOCATIONS = "riderLocations";
const WATCHES = "riderLocationWatches";
const ALERTS = "alerts";
const USERS = "users";
const ALERT_PRESENTATION_VERSION = 1;
const ID_PART = /^[A-Za-z0-9_-]{1,128}$/;

/** Where an Admin or Dispatcher acts: the fleet map, focused on the Rider. */
const TRACKING_PATH = (riderUid) => `/dispatcher/live-tracking?rider=${encodeURIComponent(riderUid)}`;

const firstText = (...values) => values.find((v) => typeof v === "string" && v.trim() !== "")?.trim() ?? null;

function resolveFields(FieldValue, reason, riderName) {
  return {
    status: "resolved",
    resolvedAt: FieldValue.serverTimestamp(),
    resolutionReason: reason,
    resolvedBy: "server",
    message: S.staleAlertText({ status: "resolved", riderName, resolutionReason: reason }),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

/**
 * Evaluate one Rider at server time `now`. Returns
 * { raised, reopened, resolved, previousResolved, watching, stale, reason? }.
 */
async function evaluateRiderLocationStale({ db, FieldValue, Timestamp, riderUid, now }) {
  if (!ID_PART.test(riderUid ?? "")) return { skipped: "unsafe_id" };
  const nowMs = now.getTime();
  return db.runTransaction(async (tx) => {
    // ---- reads
    const stateSnap = await tx.get(db.collection(STATES).doc(riderUid));
    const state = stateSnap.exists ? stateSnap.data() : null;
    const tripId = typeof state?.tripId === "string" && ID_PART.test(state.tripId) ? state.tripId : null;
    const tripSnap = tripId ? await tx.get(db.collection(TRIPS).doc(tripId)) : null;
    const trip = tripSnap?.exists ? tripSnap.data() : null;
    const locationSnap = await tx.get(db.collection(LOCATIONS).doc(riderUid));
    const location = locationSnap.exists ? locationSnap.data() : null;
    const watchRef = db.collection(WATCHES).doc(riderUid);
    const watchSnap = await tx.get(watchRef);
    const watch = watchSnap.exists ? watchSnap.data() : null;

    const target = S.watchedTrip({ riderUid, state, trip });
    const alertRef = target.watched ? db.collection(ALERTS).doc(S.alertId(riderUid, target.tripId)) : null;
    const alertSnap = alertRef ? await tx.get(alertRef) : null;
    const alert = alertSnap?.exists ? alertSnap.data() : null;
    const previousTripId = typeof watch?.tripId === "string" && ID_PART.test(watch.tripId) && watch.tripId !== target.tripId ? watch.tripId : null;
    const previousRef = previousTripId ? db.collection(ALERTS).doc(S.alertId(riderUid, previousTripId)) : null;
    const previousSnap = previousRef ? await tx.get(previousRef) : null;
    const previousAlert = previousSnap?.exists ? previousSnap.data() : null;

    const d = S.staleDecision({ riderUid, state, trip, location, watch, alert, previousAlert, nowMs });
    const raising = d.alert && (d.alert.create || d.alert.reopen);
    const riderSnap = raising ? await tx.get(db.collection(USERS).doc(riderUid)) : null;
    const rider = riderSnap?.exists ? riderSnap.data() : null;
    const riderName = firstText(rider?.fullName, rider?.name, rider?.displayName, alert?.riderName);

    // ---- writes
    const stamp = FieldValue.serverTimestamp();
    const out = { raised: false, reopened: false, resolved: false, previousResolved: false, watching: target.watched, stale: d.stale };
    if (d.previousAlert?.resolve) {
      tx.update(previousRef, resolveFields(FieldValue, d.previousAlert.resolve, previousAlert.riderName));
      out.previousResolved = true;
    }
    if (d.alert?.create || d.alert?.reopen) {
      const f = d.alert.create ?? d.alert.reopen;
      const minutes = Math.floor((nowMs - f.staleSinceMs) / 60000);
      const common = {
        status: "active",
        read: false,
        message: S.staleAlertText({ status: "active", riderName, minutes }),
        riderName: riderName ?? null,
        staleSinceAt: Timestamp.fromMillis(f.staleSinceMs),
        lastFixAt: f.lastFixMs !== null ? Timestamp.fromMillis(f.lastFixMs) : null,
        anchorSource: f.anchorSource,
        staleMinutesAtDetection: minutes,
        orderCount: Array.isArray(state?.orderIds) ? state.orderIds.length : 0,
        resolvedAt: null,
        resolutionReason: null,
        lastDetectedAt: stamp,
        updatedAt: stamp,
      };
      if (d.alert.create) {
        tx.create(alertRef, {
          ...common,
          type: S.ALERT_TYPE,
          severity: "warning",
          title: "Rider location not updating",
          riderId: riderUid,
          tripId: target.tripId,
          episodeCount: 1,
          thresholdMinutes: S.STALE_RULES.staleAfterMs / 60000,
          presentationVersion: ALERT_PRESENTATION_VERSION,
          path: TRACKING_PATH(riderUid),
          source: "server",
          createdAt: stamp,
        });
        out.raised = true;
      } else {
        tx.update(alertRef, {
          ...common,
          episodeCount: (Number.isInteger(alert.episodeCount) ? alert.episodeCount : 1) + 1,
          reopenedAt: stamp,
        });
        out.reopened = true;
      }
    } else if (d.alert?.resolve) {
      tx.update(alertRef, resolveFields(FieldValue, d.alert.resolve, alert.riderName));
      out.resolved = true;
    }
    if (d.watch?.set) {
      tx.set(watchRef, {
        riderUid,
        tripId: d.watch.set.tripId,
        anchorAt: Timestamp.fromMillis(d.watch.set.anchorMs),
        anchorSource: d.watch.set.anchorSource,
        status: d.watch.set.status,
        active: true,
        updatedAt: stamp,
      });
    } else if (d.watch?.close) {
      tx.set(watchRef, { status: "closed", active: false, closedReason: d.watch.reason, updatedAt: stamp }, { merge: true });
    }
    return out;
  });
}

/** Rider uids from a paged single-field equality query (no composite index). */
async function collectUids(db, collection, field, value, { pageSize, maxPages }, into) {
  let last = null;
  for (let page = 0; page < maxPages; page += 1) {
    let q = db.collection(collection).where(field, "==", value).orderBy("__name__").limit(pageSize);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    for (const doc of snap.docs) into.add(doc.id);
    if (snap.size < pageSize) return;
    last = snap.docs[snap.docs.length - 1];
  }
}

/**
 * The scheduled sweep: every Rider on a departed trip, plus every Rider whose
 * watch is still open (so a trip that ended resolves its alert). Bounded by
 * pageSize × maxPages per collection; one Rider's failure never stops the rest
 * (it is simply re-evaluated next run).
 */
async function evaluateStaleLocationsRun({
  db, FieldValue, Timestamp, now, pageSize = 100, maxPages = 10,
  // The per-Rider step; replaceable only so tests can make one Rider fail.
  evaluate = evaluateRiderLocationStale,
}) {
  const counts = { riders: 0, raised: 0, reopened: 0, resolved: 0, failed: 0 };
  const uids = new Set();
  await collectUids(db, STATES, "state", "on_trip", { pageSize, maxPages }, uids);
  await collectUids(db, WATCHES, "active", true, { pageSize, maxPages }, uids);
  for (const riderUid of [...uids].sort()) {
    counts.riders += 1;
    try {
      const r = await evaluate({ db, FieldValue, Timestamp, riderUid, now });
      if (r.raised) counts.raised += 1;
      if (r.reopened) counts.reopened += 1;
      if (r.resolved || r.previousResolved) counts.resolved += 1;
    } catch (error) {
      // Logged and skipped: its watch and alert are unchanged (the transaction
      // wrote nothing), so the next run evaluates this Rider again.
      counts.failed += 1;
      console.error("staleLocations: rider failed", { riderUid, code: error?.code ?? null, errorType: error?.constructor?.name ?? typeof error });
    }
  }
  return counts;
}

/**
 * A new fix arrived: resolve an open stale incident at once instead of at the
 * next sweep. One read for every other Rider (the watch says "not stale").
 */
async function resolveStaleOnFix({ db, FieldValue, Timestamp, riderUid, now }) {
  if (!ID_PART.test(riderUid ?? "")) return { skipped: "unsafe_id" };
  const watch = await db.collection(WATCHES).doc(riderUid).get();
  if (!watch.exists || watch.data().status !== "stale") return { skipped: "not_stale" };
  return evaluateRiderLocationStale({ db, FieldValue, Timestamp, riderUid, now });
}

module.exports = {
  WATCHES,
  TRACKING_PATH,
  evaluateRiderLocationStale,
  evaluateStaleLocationsRun,
  resolveStaleOnFix,
};
