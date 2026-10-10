"use strict";

/**
 * Every route field an order can carry, derived from the only two writers
 * (src/services/orderService.js saveOrderRoute / saveRiderTripRoute) and the
 * rules allowlists routeFields() / tripFields(). A route is drawn from the
 * ASSIGNED rider's position at generation time to the destination at that
 * time, so it belongs to one rider and one destination: when either changes,
 * all of it is stale.
 *
 * tests/riderTracking.test.js checks these lists against the rules and the
 * web mirror (src/services/orderRouteFields.js).
 */

/** The order's own route (Dispatcher "Generate route & ETA"). */
const ORDER_ROUTE_FIELDS = Object.freeze([
  "routePolyline",
  "routeDistanceMeters",
  "routeDurationSeconds",
  "routeEtaText",
  "routeGeneratedAt",
  "routeProvider",
  "routeDestinationRevision",
]);

/** The order's place on an optimized multi-stop trip (shared trip route). */
const TRIP_ROUTE_FIELDS = Object.freeze([
  "tripId",
  "tripStopCount",
  "tripPolyline",
  "tripDistanceMeters",
  "tripDurationSeconds",
  "tripGeneratedAt",
  "stopSequence",
  "stopEtaSeconds",
  "stopEtaText",
]);

const ALL_ROUTE_FIELDS = Object.freeze([...ORDER_ROUTE_FIELDS, ...TRIP_ROUTE_FIELDS]);

/**
 * `{ field: FieldValue.delete() }` for each of `fields` the order actually
 * carries — nothing for an order without a route, so callers can spread it
 * into any update unconditionally.
 */
function routeFieldDeletes(order, FieldValue, fields = ALL_ROUTE_FIELDS) {
  const out = {};
  for (const f of fields) {
    if (order && Object.prototype.hasOwnProperty.call(order, f)) out[f] = FieldValue.delete();
  }
  return out;
}

module.exports = { ORDER_ROUTE_FIELDS, TRIP_ROUTE_FIELDS, ALL_ROUTE_FIELDS, routeFieldDeletes };
