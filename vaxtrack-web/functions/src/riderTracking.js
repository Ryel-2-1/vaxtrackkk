"use strict";

/**
 * Rider live tracking + route deviation — the authoritative contract (pure).
 *
 * No Firestore, no Functions SDK: everything that DECIDES something lives here
 * so it is unit-testable and has one implementation. riderTrackingOps.js is the
 * thin transaction layer around it; the web (src/services/riderTracking.js) and
 * the Rider app (lib/tracking/tracking_contract.dart) mirror the constants, and
 * cross-contract tests pin the copies together.
 *
 * DATA (see firestore.rules for who may read/write each)
 *
 *   riderLocations/{riderUid}           current location, ONE replaceable doc per
 *                                       rider, written only by that rider
 *   riderNavigationSessions/{riderUid}  the ONE route being navigated (Start
 *                                       Navigation), written by that rider
 *   riderDeviationStates/{riderUid}     server-owned deviation state machine
 *   routeDeviationEvents/{eventId}      server-owned, create-only audit trail
 *   riderLocationViewers/{riderUid}     server-owned Med Rep visibility index
 *   alerts/{route_deviation_…}          operational alert (Admin Alerts page)
 *
 * TRACKING PERIOD
 *   A rider reports location while assigned to at least one order in
 *   TRACKED_ORDER_STATUSES. Deviation is monitored only for the single order the
 *   rider started navigation for, and only while it is in NAVIGABLE_STATUSES.
 *
 * DEVIATION RULE (evaluateDeviation)
 *   Deviating once accepted samples stay MORE than 500 m from the route — the
 *   nearest SEGMENT of the stored polyline — continuously for ≥ 3 minutes.
 *   Exactly 500 m is on route. Recovery (hysteresis) needs < 400 m continuously
 *   for ≥ 2 minutes. Samples with no/poor accuracy (> 100 m), invalid
 *   coordinates, or a time not newer than the last evaluated one are ignored.
 *   A gap > 2 minutes between the session's fixes breaks continuity, so
 *   "3 minutes" is never inferred across missing data. No route → no deviation.
 *
 * WHICH FIXES ARE EVALUATED (navigationFixDecision)
 *   Only a fix the Rider app TAGGED with the current session (its
 *   navigationSessionId and order). Ordinary tracking fixes are untagged and
 *   are never measured against a route, and they neither bridge nor break the
 *   3-minute timer. A session left behind (app killed, reinstalled, signed out
 *   offline) is ended as abandoned when an untagged fix arrives and the session
 *   is STALE: no tagged fix for 3 minutes (or none since the start-up grace).
 *
 * EVENT ORDER (sessionEvidence)
 *   Location triggers are delivered at least once and in ANY order. Staleness
 *   is therefore never judged from one event's before/after pair alone: every
 *   tagged fix of the session that any event observes (its own fix, the fix
 *   before it, the stored current fix) is recorded on the deviation state as a
 *   monotonic maximum, and a session whose tagged history is not on record is
 *   never presumed stale (missing history is not proof that no tagged fix came).
 *
 * CONFIRMED CONTINUITY (navigation continuity version 1)
 *   Trigger snapshots alone cannot close the race: a tagged fix Tn is visible
 *   only to its own event, to the next write's event (as `before`) and while it
 *   is the stored document. If both events are still undelivered when a later
 *   untagged fix is processed, nothing the server can read shows that Tn was
 *   ever written. So a session started with `continuityVersion: 1` carries its
 *   own durable anchor: after each QUALIFYING tagged fix is stored, the Rider
 *   app writes `lastNavigationFixAt` on its session document, and
 *   firestore.rules accept it only when it EQUALS the server write time
 *   (updatedAt, pinned to request.time) of the stored location — tagged with
 *   this session and order, accurate to 100 m, written within 60 s of capture
 *   — and moves forward while the session is navigating. One client's writes
 *   commit in order, so that confirmation is stored before any later location
 *   write of the app; every handler reads the session document in its own
 *   transaction, whatever order the events arrive in. Staleness of such a
 *   session is decided from qualifying fixes only (confirmedSessionIsStale).
 *   Sessions started by older app builds keep the evidence rule above.
 *
 * TIME
 *   Elapsed time is the SERVER write time of each fix (riderLocations.updatedAt,
 *   pinned to request.time by firestore.rules). The device's capture time only
 *   filters out a fix delivered late (offline queue): its position is not "now".
 */

const TRACKED_ORDER_STATUSES = Object.freeze(["assigned", "loading", "in_transit", "delayed"]);
const NAVIGABLE_STATUSES = Object.freeze(["in_transit", "delayed"]);

const DEVIATION_RULES = Object.freeze({
  offRouteMeters: 500,
  returnMeters: 400,
  confirmDeviationMs: 3 * 60 * 1000,
  confirmReturnMs: 2 * 60 * 1000,
  maxAccuracyMeters: 100,
  maxSampleGapMs: 2 * 60 * 1000,
  /** A fix written more than this after it was captured is not a deviation sample. */
  maxFixAgeMs: 60 * 1000,
});

/**
 * Navigation-session lifecycle on the server. An untagged (ordinary) fix ends a
 * session as ABANDONED only when the session is genuinely stale:
 *   * staleAfterMs — since the LAST fix tagged with that exact session (server
 *     time). A navigating app tags a fix at least every 30 s, so a session with
 *     a tagged fix seconds ago survives an accidental untagged write;
 *   * untaggedGraceMs — since the session started, used ONLY when no tagged fix
 *     ever arrived (covers the instant between Start Navigation and the app
 *     tagging its first fix).
 */
const SESSION_RULES = Object.freeze({
  untaggedGraceMs: 60 * 1000,
  staleAfterMs: 3 * 60 * 1000,
});

/** Display freshness, from the fix's capture time (never newer than the server write). */
const FRESHNESS = Object.freeze({ freshMs: 2 * 60 * 1000, offlineMs: 10 * 60 * 1000 });

/**
 * A session document that declares this version promises a confirmation
 * (lastNavigationFixAt) for every qualifying tagged fix of the session.
 */
const NAVIGATION_CONTINUITY_VERSION = 1;

const TRACKING_STATES = Object.freeze(["active", "paused", "ended"]);
const SESSION_STATES = Object.freeze(["navigating", "ended"]);
const LOCATION_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------- statuses

/** "In Transit" / "in-transit" → "in_transit"; legacy aliases mapped. */
function normalizeStatus(value) {
  if (typeof value !== "string") return "";
  const key = value.trim().toLowerCase().replace(/[-\s]+/g, "_");
  return key === "completed" ? "delivered" : key === "canceled" ? "cancelled" : key;
}

const isTrackedStatus = (status) => TRACKED_ORDER_STATUSES.includes(normalizeStatus(status));
const isNavigableStatus = (status) => NAVIGABLE_STATUSES.includes(normalizeStatus(status));

// ---------------------------------------------------------------- geometry

const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;
const M_PER_DEG_LAT = EARTH_RADIUS_M * DEG;

function isValidCoordinate(lat, lng) {
  return (
    typeof lat === "number" && typeof lng === "number" &&
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 &&
    !(lat === 0 && lng === 0) // "null island" is a device default, never a delivery position
  );
}

function normalizeLngDelta(d) {
  let x = d;
  while (x > 180) x -= 360;
  while (x < -180) x += 360;
  return x;
}

function haversineMeters(a, b) {
  const dLat = (b.lat - a.lat) * DEG;
  const dLng = normalizeLngDelta(b.lng - a.lng) * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Shortest distance in metres from `point` to the polyline `route`, measured to
 * the nearest SEGMENT (perpendicular foot clamped to the segment), not to a
 * vertex or the destination. Local equirectangular frame centred on the point
 * — sub-metre error at city scale. Mirrors Dart distanceToPolylineMeters.
 * Empty route → Infinity; one point → great-circle distance.
 */
function distanceToPolylineMeters(point, route) {
  if (!Array.isArray(route) || route.length === 0) return Infinity;
  if (route.length === 1) return haversineMeters(point, route[0]);
  const mPerDegLng = M_PER_DEG_LAT * Math.cos(point.lat * DEG);
  const x = (c) => normalizeLngDelta(c.lng - point.lng) * mPerDegLng;
  const y = (c) => (c.lat - point.lat) * M_PER_DEG_LAT;
  let best = Infinity;
  let ax = x(route[0]);
  let ay = y(route[0]);
  for (let i = 1; i < route.length; i += 1) {
    const bx = x(route[i]);
    const by = y(route[i]);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let d;
    if (len2 === 0) {
      d = Math.hypot(ax, ay);
    } else {
      const t = Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2));
      d = Math.hypot(ax + t * dx, ay + t * dy);
    }
    if (d < best) best = d;
    ax = bx;
    ay = by;
  }
  return best;
}

/**
 * Decode a precision-5 encoded polyline (the format the Dispatcher stores).
 * Defensive: malformed input yields [] rather than garbage or an endless loop,
 * and any invalid coordinate invalidates the whole route.
 */
function decodePolyline(encoded) {
  if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > 200000) return [];
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let b;
    do {
      if (index >= encoded.length || shift > 30) return null;
      b = encoded.charCodeAt(index++) - 63;
      if (b < 0 || b > 63) return null;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    const dLat = next();
    const dLng = next();
    if (dLat === null || dLng === null) return [];
    lat += dLat;
    lng += dLng;
    const p = { lat: lat / 1e5, lng: lng / 1e5 };
    if (!isValidCoordinate(p.lat, p.lng)) return [];
    points.push(p);
  }
  return points;
}

/** Why a stored route is not used (stored on the deviation state, shown to staff). */
const ROUTE_UNAVAILABLE_REASONS = Object.freeze({
  MISSING: "missing",
  MALFORMED: "malformed",
  BEFORE_ASSIGNMENT: "generated_before_assignment",
  DESTINATION_CHANGED: "destination_changed",
});

const unavailableRoute = (reason) => ({ available: false, source: null, points: [], fingerprint: null, reason });

/**
 * The AUTHORITATIVE route for an order: the dispatcher-saved whole-trip route
 * when the order is a stop on an optimized trip, else its own route. Never a
 * straight line between origin and destination.
 *
 * A stored route is used only when it provably belongs to the CURRENT
 * assignment and destination. Routes start at the rider's position when the
 * dispatcher generated them, and requeue/reassignment does not clear them, so
 * a route saved before `assignedAt` may have been drawn from another rider's
 * position; a route for an older destination revision leads somewhere else.
 * Either case is "unavailable" — never a basis for a deviation.
 */
function routeForOrder(order) {
  // Same rule as the Rider app (Delivery.isOnTrip + compliancePolyline): a stop
  // on an optimized trip (tripId + stopSequence > 0) uses the whole-trip route.
  const onTrip = typeof order?.tripId === "string" && order.tripId !== "" && Number(order?.stopSequence ?? 0) > 0;
  const useTrip = onTrip && typeof order?.tripPolyline === "string" && order.tripPolyline !== "";
  const encoded = useTrip ? order.tripPolyline : order?.routePolyline;
  const source = useTrip ? "trip" : "order";
  if (typeof encoded !== "string" || encoded === "") return unavailableRoute(ROUTE_UNAVAILABLE_REASONS.MISSING);
  const points = decodePolyline(encoded);
  if (points.length < 2) return unavailableRoute(ROUTE_UNAVAILABLE_REASONS.MALFORMED);

  const generatedMs = millisOf(useTrip ? order.tripGeneratedAt : order.routeGeneratedAt);
  const assignedMs = millisOf(order.assignedAt);
  if (generatedMs === null || assignedMs === null || generatedMs < assignedMs) {
    return unavailableRoute(ROUTE_UNAVAILABLE_REASONS.BEFORE_ASSIGNMENT);
  }
  if (useTrip) {
    // Trips carry no destination revision: a correction after the trip was
    // generated makes it stale.
    const correctedMs = millisOf(order.destinationCorrectedAt);
    if (correctedMs !== null && generatedMs < correctedMs) return unavailableRoute(ROUTE_UNAVAILABLE_REASONS.DESTINATION_CHANGED);
  } else if ((order.routeDestinationRevision ?? 0) !== (order.destinationRevision ?? 0)) {
    return unavailableRoute(ROUTE_UNAVAILABLE_REASONS.DESTINATION_CHANGED);
  }

  // Changing route ⇒ new fingerprint (a cheap stable hash of the encoded string).
  let h = 2166136261;
  for (let i = 0; i < encoded.length; i += 1) h = Math.imul(h ^ encoded.charCodeAt(i), 16777619) >>> 0;
  return { available: true, source, points, fingerprint: `${source}:${encoded.length}:${h.toString(16)}`, reason: null };
}

// ---------------------------------------------------------------- samples + freshness

/** Epoch millis from a Firestore Timestamp / Date / number, else null. */
function millisOf(value) {
  if (value == null) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

/**
 * A riderLocations document as a deviation sample, or { ok: false, reason }.
 * The sample's time (`atMs`) is the SERVER write time: a device clock can never
 * stretch or shrink the 3 minutes. A fix written long after its capture (an
 * offline queue flushing) is refused — that position is not the rider's now.
 */
function sampleFromLocation(location, rules = DEVIATION_RULES) {
  if (!location || location.trackingState !== "active") return { ok: false, reason: "not_tracking" };
  const lat = location.latitude;
  const lng = location.longitude;
  if (!isValidCoordinate(lat, lng)) return { ok: false, reason: "invalid_coordinates" };
  const accuracy = location.accuracyMeters;
  if (typeof accuracy !== "number" || !Number.isFinite(accuracy) || accuracy < 0) return { ok: false, reason: "no_accuracy" };
  if (accuracy > rules.maxAccuracyMeters) return { ok: false, reason: "poor_accuracy" };
  const captured = millisOf(location.capturedAt);
  const updated = millisOf(location.updatedAt);
  if (captured === null) return { ok: false, reason: "no_capture_time" };
  if (updated === null) return { ok: false, reason: "no_server_time" };
  if (updated - captured > rules.maxFixAgeMs) return { ok: false, reason: "stale_fix" };
  return { ok: true, sample: { lat, lng, accuracyMeters: accuracy, atMs: updated } };
}

/**
 * What a location write means for the rider's CURRENT navigation session:
 *   { action: "evaluate" }               a fix the app tagged with this session
 *                                        and its order — measure it;
 *   { action: "end", reason }            the app is not navigating it any more:
 *                                        "tracking_stopped" (sharing ended) or
 *                                        "abandoned" (an untagged fix while the
 *                                        session is STALE) — close it, never
 *                                        evaluate it;
 *   { action: "ignore", reason }         anything else (a fix for another
 *                                        session or order, an untagged fix while
 *                                        the session is still live, a write
 *                                        before the session).
 * `lastTaggedFixAtMs` is the newest server time of a fix tagged with this
 * exact session that the server has observed (sessionEvidence), or null.
 * `taggedHistorySinceMs` is when complete recording of those fixes began (the
 * session start for a state created with the session); null means there is no
 * record at all, so an untagged fix is never taken as proof of staleness.
 * `lastQualifyingFixAtMs` is the newest QUALIFYING fix of the session the
 * server observed; for a session with confirmed continuity it is combined
 * with the session's own confirmation (confirmedSessionIsStale) and the two
 * tagged-history inputs are not used.
 * Every time compared is server time (updatedAt / startedAt).
 */
function navigationFixDecision({ session, location, lastTaggedFixAtMs = null, taggedHistorySinceMs = null, lastQualifyingFixAtMs = null, rules = SESSION_RULES }) {
  const startedMs = millisOf(session?.startedAt);
  const writtenMs = millisOf(location?.updatedAt);
  if (!session || !location) return { action: "ignore", reason: "no_session" };
  if (startedMs !== null && writtenMs !== null && writtenMs <= startedMs) {
    return { action: "ignore", reason: "before_session" };
  }
  if (location.trackingState === "ended") return { action: "end", reason: "tracking_stopped" };
  if (location.trackingState !== "active") return { action: "ignore", reason: "not_tracking" };
  const tag = location.navigationSessionId ?? null;
  if (tag === null) {
    // Untagged: ordinary tracking. Never evaluated against the route, and it
    // ends the session only when that session is genuinely stale.
    if (writtenMs === null) return { action: "ignore", reason: "untagged_fix" };
    const stale = hasConfirmedContinuity(session)
      ? confirmedSessionIsStale({ writtenMs, startedMs, lastQualifyingFixAtMs: laterOf(confirmedNavigationFixMs(session), lastQualifyingFixAtMs), rules })
      : untaggedSessionIsStale({ writtenMs, startedMs, lastTaggedFixAtMs, taggedHistorySinceMs, rules });
    return stale ? { action: "end", reason: "abandoned" } : { action: "ignore", reason: "untagged_fix" };
  }
  if (tag !== session.sessionId) return { action: "ignore", reason: "other_session" };
  if ((location.activeOrderId ?? null) !== session.orderId) return { action: "ignore", reason: "other_order" };
  return { action: "evaluate", reason: null };
}

/**
 * Is the session STALE for an untagged fix written at `writtenMs`?
 *   * No record (`taggedHistorySinceMs` null): never — the server cannot know.
 *   * Complete record since the session start and no tagged fix ever: stale
 *     after the start-up grace (untaggedGraceMs) from the start.
 *   * Otherwise: stale once staleAfterMs has passed since the later of the last
 *     recorded tagged fix and the moment recording began — so a record that
 *     began mid-session (a state written before recording existed) first has
 *     to cover a full stale period before it can prove anything.
 */
function untaggedSessionIsStale({ writtenMs, startedMs, lastTaggedFixAtMs, taggedHistorySinceMs, rules = SESSION_RULES }) {
  if (!Number.isFinite(writtenMs) || !Number.isFinite(taggedHistorySinceMs)) return false;
  const last = Number.isFinite(lastTaggedFixAtMs) ? lastTaggedFixAtMs : null;
  const completeFromStart = Number.isFinite(startedMs) && taggedHistorySinceMs <= startedMs;
  if (last === null && completeFromStart) return writtenMs - startedMs >= rules.untaggedGraceMs;
  return writtenMs - Math.max(taggedHistorySinceMs, last ?? -Infinity) >= rules.staleAfterMs;
}

/** Was the session started by an app that confirms every qualifying fix? */
function hasConfirmedContinuity(session) {
  return session?.continuityVersion === NAVIGATION_CONTINUITY_VERSION;
}

/**
 * The session's own confirmed anchor: the server write time of its newest
 * qualifying tagged fix (firestore.rules verify it against the stored fix),
 * or null — none yet, an older app's session, or a value not after the start.
 */
function confirmedNavigationFixMs(session) {
  if (!hasConfirmedContinuity(session)) return null;
  const at = millisOf(session.lastNavigationFixAt);
  const started = millisOf(session.startedAt);
  if (at === null || (started !== null && at <= started)) return null;
  return at;
}

/**
 * Is a session with confirmed continuity STALE for an untagged fix written at
 * `writtenMs`? Its qualifying history is complete from the start (every
 * qualifying fix is confirmed before any later write of the app commits), so:
 *   * no qualifying fix yet: stale once the start-up grace has passed;
 *   * otherwise: stale once staleAfterMs has passed since the newest one.
 * Only QUALIFYING fixes count — a tagged fix that is inaccurate or was written
 * long after capture never keeps a session alive. Without a server start time
 * nothing can be judged: never stale.
 */
function confirmedSessionIsStale({ writtenMs, startedMs, lastQualifyingFixAtMs, rules = SESSION_RULES }) {
  if (!Number.isFinite(writtenMs) || !Number.isFinite(startedMs)) return false;
  const last = Number.isFinite(lastQualifyingFixAtMs) && lastQualifyingFixAtMs > startedMs ? lastQualifyingFixAtMs : null;
  if (last === null) return writtenMs - startedMs >= rules.untaggedGraceMs;
  return writtenMs - last >= rules.staleAfterMs;
}

/**
 * Server times a location document contributes to THIS session (`session`'s
 * id, order AND rider), or nulls:
 *   taggedAtMs      an active fix the app tagged with this session, with valid
 *                   coordinates — proof the app is navigating it (staleness);
 *   qualifyingAtMs  the same, AND a usable deviation sample (accuracy, server
 *                   time, not delivered late) — the only fixes that count for
 *                   the continuity of the 3-minute timer.
 * Ordinary (untagged) fixes, other sessions or orders, and ended sharing
 * contribute nothing.
 */
function sessionFixTimes(doc, session, rules = DEVIATION_RULES) {
  const none = { taggedAtMs: null, qualifyingAtMs: null };
  if (!doc || !session || doc.trackingState !== "active") return none;
  if (session.riderUid != null && doc.riderUid !== session.riderUid) return none;
  if ((doc.navigationSessionId ?? null) !== session.sessionId || session.sessionId == null) return none;
  if ((doc.activeOrderId ?? null) !== session.orderId) return none;
  if (!isValidCoordinate(doc.latitude, doc.longitude)) return none;
  const updated = millisOf(doc.updatedAt);
  if (updated === null) return none;
  const sample = sampleFromLocation(doc, rules);
  return { taggedAtMs: updated, qualifyingAtMs: sample.ok ? sample.sample.atMs : null };
}

/** The later of two optional times. */
function laterOf(a, b) {
  if (!Number.isFinite(a)) return Number.isFinite(b) ? b : null;
  if (!Number.isFinite(b)) return a;
  return Math.max(a, b);
}

/**
 * What the server knows about this session's navigation activity, from one
 * trigger event, and what to RECORD so that a later event — delivered in any
 * order — knows it too.
 *
 * Inputs: the event's own fix (`location`), the fix before it (`previous`),
 * the location document as currently stored (`current`), and the session's
 * own deviation state (`state`, null when it is not this session's). Only
 * fixes of this exact session, order and rider count (sessionFixTimes).
 *
 * Returns:
 *   lastTaggedFixAtMs       newest tagged-fix server time observed (stored, own,
 *                           previous, current) — for staleness;
 *   taggedHistorySinceMs    when complete recording began (state), or null with
 *                           no state; a state written before recording existed
 *                           starts its record at `nowMs`;
 *   previousQualifyingAtMs  latest QUALIFYING fix before this one (stored or
 *                           previous) — continuity of the 3-minute timer;
 *   lastQualifyingFixAtMs   newest QUALIFYING fix observed (stored, own,
 *                           previous, current) — staleness of a session with
 *                           confirmed continuity;
 *   ownQualifyingAtMs       this fix's own qualifying time, or null;
 *   replay                  this fix's qualifying time is already on record:
 *                           it was evaluated before (a redelivered event);
 *   patch                   fields to store — only values that move FORWARD
 *                           (never backwards), plus the record start once.
 *
 * The current document only ever adds tagged evidence, never a qualifying
 * time: it may be newer than this event's fix, and recording its qualifying
 * time first would make its own evaluation look like a replay.
 */
function sessionEvidence({ session, location, previous = null, current = null, state = null, nowMs = null, rules = DEVIATION_RULES }) {
  const own = Boolean(state) && state.sessionId === session?.sessionId;
  const storedTagged = own && Number.isFinite(state.lastTaggedFixAtMs) ? state.lastTaggedFixAtMs : null;
  const storedQualifying = own && Number.isFinite(state.lastQualifyingFixAtMs) ? state.lastQualifyingFixAtMs : null;
  const storedSince = own && Number.isFinite(state.taggedHistorySinceMs) ? state.taggedHistorySinceMs : null;
  const self = sessionFixTimes(location, session, rules);
  const prev = sessionFixTimes(previous, session, rules);
  const cur = sessionFixTimes(current, session, rules);

  const lastTaggedFixAtMs = [self.taggedAtMs, prev.taggedAtMs, cur.taggedAtMs].reduce(laterOf, storedTagged);
  const newestQualifying = laterOf(self.qualifyingAtMs, prev.qualifyingAtMs);
  const replay = Number.isFinite(self.qualifyingAtMs) && storedQualifying !== null && storedQualifying >= self.qualifyingAtMs;

  const patch = {};
  let taggedHistorySinceMs = null;
  if (own) {
    if (lastTaggedFixAtMs !== null && lastTaggedFixAtMs > (storedTagged ?? -Infinity)) patch.lastTaggedFixAtMs = lastTaggedFixAtMs;
    if (newestQualifying !== null && newestQualifying > (storedQualifying ?? -Infinity)) patch.lastQualifyingFixAtMs = newestQualifying;
    taggedHistorySinceMs = storedSince;
    if (taggedHistorySinceMs === null && Number.isFinite(nowMs)) {
      taggedHistorySinceMs = nowMs;
      patch.taggedHistorySinceMs = nowMs;
    }
  }
  return {
    lastTaggedFixAtMs,
    taggedHistorySinceMs,
    previousQualifyingAtMs: laterOf(prev.qualifyingAtMs, storedQualifying),
    lastQualifyingFixAtMs: [self.qualifyingAtMs, prev.qualifyingAtMs, cur.qualifyingAtMs].reduce(laterOf, storedQualifying),
    ownQualifyingAtMs: self.qualifyingAtMs,
    replay,
    patch,
  };
}

/**
 * Is a riderNavigationSessions write ONLY the app confirming a navigation fix
 * (lastNavigationFixAt / updatedAt) on the same, still-navigating session?
 * Such a write starts, replaces or ends nothing, so the session trigger skips
 * it without a transaction.
 */
function isFixConfirmationOnly(before, after) {
  if (!before || !after) return false;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (k === "lastNavigationFixAt" || k === "updatedAt") continue;
    if (!sameValue(before[k], after[k])) return false;
  }
  return after.state === "navigating" && !sameValue(before.lastNavigationFixAt, after.lastNavigationFixAt);
}

function sameValue(a, b) {
  const ma = millisOf(a);
  const mb = millisOf(b);
  if (ma !== null || mb !== null) return ma === mb && typeof a === typeof b;
  return a === b;
}

/**
 * Display state of a rider's current location:
 *   unavailable  no coordinates (never reported, or coordinates cleared)
 *   offline      tracking ended, or the fix is older than FRESHNESS.offlineMs
 *   stale        older than FRESHNESS.freshMs
 *   fresh        otherwise
 * Age is measured from min(capture time, server write time), so a late
 * offline write is shown as old — never as live.
 */
function locationFreshness(location, nowMs) {
  if (!location || !isValidCoordinate(location.latitude, location.longitude)) return "unavailable";
  if (location.trackingState === "ended") return "offline";
  const captured = millisOf(location.capturedAt);
  const updated = millisOf(location.updatedAt);
  const at = [captured, updated].filter((v) => v !== null).reduce((m, v) => Math.min(m, v), Infinity);
  if (!Number.isFinite(at)) return "unavailable";
  const age = nowMs - at;
  if (age > FRESHNESS.offlineMs) return "offline";
  if (age > FRESHNESS.freshMs) return "stale";
  return "fresh";
}

// ---------------------------------------------------------------- deviation state machine

/**
 * A fresh state for a navigation session. Only ANCHORS are stored: the phase,
 * when the current off-route / recovery timer started, the episode, and when
 * and how far off the last transition happened. Nothing here changes on an
 * ordinary sample, so an unchanged state is never rewritten.
 */
function initialDeviationState() {
  return {
    phase: "on_route",
    pendingOffSinceMs: null,
    pendingReturnSinceMs: null,
    lastTransitionAtMs: null,
    distanceAtTransitionMeters: null,
    episode: 0,
  };
}

/** The fields whose change is a transition worth persisting. */
const TRANSITION_KEYS = Object.freeze(["phase", "pendingOffSinceMs", "pendingReturnSinceMs", "episode"]);

/**
 * Advance the deviation state machine by ONE location sample.
 *
 *  * `sample.atMs` — the server write time of this fix (sampleFromLocation).
 *  * `previousSampleAtMs` — server time of the last QUALIFYING fix of the same
 *    session (continuityAnchors), or null. A running timer survives
 *    only if that previous fix is at most `maxSampleGapMs` older: 3 minutes is
 *    never inferred across a gap. The first qualifying off-route fix anchors
 *    `pendingOffSinceMs`; later ones keep that anchor.
 *  * `notBeforeMs` — samples at or before this (the session start) are ignored.
 *
 * Returns { state, changed, event, ignored }. `changed` is true only for a
 * transition (a timer starting, stopping or being restarted after a gap, a
 * phase change). Replaying a sample is a no-op: it is not newer than the last
 * transition. Pure and deterministic.
 */
function evaluateDeviation({ state, sample, route, previousSampleAtMs = null, notBeforeMs = null, rules = DEVIATION_RULES }) {
  const s = { ...initialDeviationState(), ...(state ?? {}) };
  const unchanged = (ignored) => ({ state: s, changed: false, event: null, ignored });
  if (!Array.isArray(route) || route.length < 2) return unchanged("no_route");
  if (!sample || !isValidCoordinate(sample.lat, sample.lng)) return unchanged("invalid_coordinates");
  if (typeof sample.accuracyMeters !== "number" || !(sample.accuracyMeters >= 0) || sample.accuracyMeters > rules.maxAccuracyMeters) {
    return unchanged("poor_accuracy");
  }
  if (!Number.isFinite(sample.atMs)) return unchanged("no_server_time");
  const t = sample.atMs;
  if (Number.isFinite(notBeforeMs) && t <= notBeforeMs) return unchanged("before_session");
  if (Number.isFinite(s.lastTransitionAtMs) && t <= s.lastTransitionAtMs) return unchanged("out_of_order");

  const before = Object.fromEntries(TRANSITION_KEYS.map((k) => [k, s[k]]));
  const continuous = Number.isFinite(previousSampleAtMs) && t > previousSampleAtMs && t - previousSampleAtMs <= rules.maxSampleGapMs;
  if (!continuous) {
    // A gap: running timers restart from this sample.
    s.pendingOffSinceMs = null;
    s.pendingReturnSinceMs = null;
  }
  const d = distanceToPolylineMeters({ lat: sample.lat, lng: sample.lng }, route);
  const distance = Math.round(d * 10) / 10;
  let event = null;

  if (s.phase === "on_route") {
    if (d > rules.offRouteMeters) {
      if (s.pendingOffSinceMs === null) s.pendingOffSinceMs = t;
      if (t - s.pendingOffSinceMs >= rules.confirmDeviationMs) {
        event = { type: "deviated", atMs: t, distanceMeters: distance, sinceMs: s.pendingOffSinceMs };
        s.phase = "deviating";
        s.episode += 1;
        s.pendingOffSinceMs = null;
        s.pendingReturnSinceMs = null;
      }
    } else {
      // Back within 500 m before 3 minutes: the pending timer resets.
      s.pendingOffSinceMs = null;
    }
  } else if (d < rules.returnMeters) {
    if (s.pendingReturnSinceMs === null) s.pendingReturnSinceMs = t;
    if (t - s.pendingReturnSinceMs >= rules.confirmReturnMs) {
      event = { type: "returned", atMs: t, distanceMeters: distance, sinceMs: s.pendingReturnSinceMs };
      s.phase = "on_route";
      s.pendingReturnSinceMs = null;
      s.pendingOffSinceMs = null;
    }
  } else {
    // 400–500 m (hysteresis band) or still off route: recovery must restart.
    s.pendingReturnSinceMs = null;
  }
  const changed = TRANSITION_KEYS.some((k) => s[k] !== before[k]);
  if (changed) {
    s.lastTransitionAtMs = t;
    s.distanceAtTransitionMeters = distance;
  }
  return { state: s, changed, event, ignored: null };
}

/** Display label of a server deviation state (Admin/Dispatcher marker). */
function deviationDisplayState(stateDoc) {
  if (!stateDoc || stateDoc.sessionState !== "navigating") return "not_navigating";
  if (stateDoc.routeStatus !== "available") return "route_unavailable";
  if (stateDoc.phase === "deviating") return "deviating";
  if (stateDoc.pendingOffSinceMs != null) return "pending_deviation";
  return "on_route";
}

// ---------------------------------------------------------------- ids, alerts, events

const ID_PART = /^[A-Za-z0-9_-]{1,128}$/;

function assertIdPart(name, value) {
  if (typeof value !== "string" || !ID_PART.test(value)) throw new Error(`${name} is not a safe identifier`);
  return value;
}

/** One alert per rider + order + navigation session. */
function deviationAlertId({ orderId, riderUid, sessionId }) {
  return `route_deviation_${assertIdPart("orderId", orderId)}_${assertIdPart("riderUid", riderUid)}_${assertIdPart("sessionId", sessionId)}`;
}

/** One event per session + episode + transition: a retry can never duplicate it. */
function deviationEventId({ sessionId, episode, type }) {
  if (!Number.isInteger(episode) || episode < 1) throw new Error("episode must be a positive integer");
  if (!["deviated", "returned", "session_closed"].includes(type)) throw new Error("unknown event type");
  return `${assertIdPart("sessionId", sessionId)}_e${episode}_${type}`;
}

/**
 * The alert write for a deviation-state transition, given the existing alert
 * (null when none). Shapes match the existing Admin Alerts renderer
 * (type route_deviation). `serverTimestamps` lists fields the caller sets to
 * the server time. Returns { action: "create"|"reopen"|"resolve"|"noop", data, serverTimestamps }.
 */
function planAlertWrite({ existing, transition, context }) {
  const order = context.orderNumber || context.orderId;
  if (transition.type === "deviated") {
    const message = `Rider ${context.riderName || ""}`.trim() +
      ` has been more than ${DEVIATION_RULES.offRouteMeters} m from the assigned route for order ${order} for at least 3 minutes (now ${Math.round(transition.distanceMeters)} m off route).`;
    if (!existing) {
      return {
        action: "create",
        data: {
          type: "route_deviation",
          severity: "critical",
          status: "active",
          read: false,
          title: "Route Deviation Detected",
          message,
          orderId: context.orderId,
          deliveryId: context.orderId,
          orderNumber: context.orderNumber ?? null,
          riderId: context.riderUid,
          riderName: context.riderName ?? null,
          navigationSessionId: context.sessionId,
          episodeCount: 1,
          distanceMeters: transition.distanceMeters,
          deviatingSinceMs: transition.sinceMs,
          resolutionReason: null,
          resolvedAt: null,
          source: "server",
        },
        serverTimestamps: ["createdAt", "firstCreatedAt", "updatedAt", "lastDetectedAt"],
      };
    }
    if (existing.status === "active") {
      // Already open for this session: refresh, never a second alert.
      return { action: "noop", data: {}, serverTimestamps: [] };
    }
    return {
      action: "reopen",
      data: {
        status: "active",
        read: false,
        message,
        episodeCount: (Number.isInteger(existing.episodeCount) ? existing.episodeCount : 1) + 1,
        distanceMeters: transition.distanceMeters,
        deviatingSinceMs: transition.sinceMs,
        resolutionReason: null,
        resolvedAt: null,
      },
      serverTimestamps: ["updatedAt", "lastDetectedAt", "reopenedAt"],
    };
  }
  // "returned" or "session_closed": resolve an OPEN alert; never create one.
  if (!existing || existing.status !== "active") return { action: "noop", data: {}, serverTimestamps: [] };
  return {
    action: "resolve",
    data: {
      status: "resolved",
      resolutionReason: transition.type === "returned" ? "returned_to_route" : transition.reason || "session_closed",
    },
    serverTimestamps: ["resolvedAt", "updatedAt"],
  };
}

// ---------------------------------------------------------------- Med Rep visibility

/**
 * Who may see a rider's location besides Admin/Dispatcher: the Med Reps who own
 * an order that is assigned to that rider AND still tracked. Terminal or parked
 * orders give no visibility. Deterministic (sorted, de-duplicated).
 */
function viewersForRider(riderUid, orders) {
  const viewers = new Set();
  const activeOrderIds = new Set();
  for (const { id, data } of orders) {
    if (data?.assignedRiderId !== riderUid || !isTrackedStatus(data?.status)) continue;
    activeOrderIds.add(id);
    if (typeof data.createdByUid === "string" && data.createdByUid !== "") viewers.add(data.createdByUid);
  }
  return { viewerUids: [...viewers].sort(), activeOrderIds: [...activeOrderIds].sort() };
}

/** Riders whose visibility may have changed between two versions of an order. */
function ridersAffectedByOrderWrite(before, after) {
  const relevant = (o) => (o ? [o.assignedRiderId, normalizeStatus(o.status), o.createdByUid].join("|") : "");
  if (relevant(before) === relevant(after)) return [];
  return [...new Set([before?.assignedRiderId, after?.assignedRiderId].filter((r) => typeof r === "string" && r !== ""))].sort();
}

/**
 * Should an order change end the navigation session that points at it?
 * Yes when the order stopped being navigable for that rider: completed,
 * cancelled, failed, parked, unassigned or reassigned, or deleted.
 */
function sessionEndReasonForOrder(order, riderUid) {
  if (!order) return "order_missing";
  if (order.assignedRiderId !== riderUid) return "reassigned";
  const status = normalizeStatus(order.status);
  if (status === "delivered") return "completed";
  if (status === "cancelled") return "cancelled";
  if (status === "delivery_failed") return "failed";
  if (!NAVIGABLE_STATUSES.includes(status)) return "not_navigable";
  return null;
}

// ---------------------------------------------------------------- retention

const RETENTION = Object.freeze({
  /** A current-location doc not refreshed for this long is deleted. */
  locationMaxIdleMs: 24 * 60 * 60 * 1000,
  /** Ended navigation sessions and their server state are deleted after this. */
  endedSessionMs: 24 * 60 * 60 * 1000,
  /** Deviation audit events are deleted after this. */
  deviationEventMs: 90 * 24 * 60 * 60 * 1000,
});

module.exports = {
  TRACKED_ORDER_STATUSES,
  NAVIGABLE_STATUSES,
  DEVIATION_RULES,
  SESSION_RULES,
  FRESHNESS,
  TRACKING_STATES,
  SESSION_STATES,
  LOCATION_SCHEMA_VERSION,
  NAVIGATION_CONTINUITY_VERSION,
  RETENTION,
  ROUTE_UNAVAILABLE_REASONS,
  normalizeStatus,
  isTrackedStatus,
  isNavigableStatus,
  isValidCoordinate,
  haversineMeters,
  distanceToPolylineMeters,
  decodePolyline,
  routeForOrder,
  millisOf,
  sampleFromLocation,
  navigationFixDecision,
  sessionFixTimes,
  untaggedSessionIsStale,
  hasConfirmedContinuity,
  confirmedNavigationFixMs,
  confirmedSessionIsStale,
  isFixConfirmationOnly,
  sessionEvidence,
  locationFreshness,
  initialDeviationState,
  TRANSITION_KEYS,
  evaluateDeviation,
  deviationDisplayState,
  deviationAlertId,
  deviationEventId,
  planAlertWrite,
  viewersForRider,
  ridersAffectedByOrderWrite,
  sessionEndReasonForOrder,
};
