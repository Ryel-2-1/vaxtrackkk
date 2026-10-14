// Every route field an order can carry — the web mirror of
// functions/src/orderRouteFields.js (tests/riderTracking.test.js keeps the two
// and the rules allowlists identical). A saved route starts at the ASSIGNED
// rider's position, so assigning a rider clears any route still on the order.

export const ORDER_ROUTE_FIELDS = Object.freeze([
  "routePolyline",
  "routeDistanceMeters",
  "routeDurationSeconds",
  "routeEtaText",
  "routeGeneratedAt",
  "routeProvider",
  "routeDestinationRevision",
]);

export const TRIP_ROUTE_FIELDS = Object.freeze([
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

export const ALL_ROUTE_FIELDS = Object.freeze([...ORDER_ROUTE_FIELDS, ...TRIP_ROUTE_FIELDS]);

/** The route fields this order actually carries. */
export function presentRouteFields(order) {
  return ALL_ROUTE_FIELDS.filter((f) => order && Object.prototype.hasOwnProperty.call(order, f));
}
