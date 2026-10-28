/**
 * Is an order's saved destination still the clinic's current one? Pure.
 *
 * An order keeps its OWN copy of where the rider must arrive — pin, arrival
 * radius and rider access details — taken when it was placed or last corrected
 * (functions/src/policy.js buildOrderDestinationSnapshot). The server checks
 * arrival against that copy, never the live clinic. So when an Admin later
 * corrects the clinic, open orders keep the old point until a Dispatcher
 * requests a refresh and the order's Med Rep approves it
 * (functions/src/destinationOperations.js, same-address "refresh").
 */
import { MAX_ACCESS_NOTES_LENGTH, validateClinicLocation } from "./clinicLocation.js";

/** Statuses whose destination can still be corrected (server CORRECTABLE_STATUSES). */
export const CORRECTABLE_DESTINATION_STATUSES = Object.freeze(["pending_dispatch", "assigned", "loading", "delivery_failed"]);

/** Statuses where a route is in use and a missing one matters. */
const ROUTED_STATUSES = Object.freeze(["assigned", "loading", "in_transit", "delayed"]);

// Same normalisation as the server's cleanSnapshotText + length cap.
const cleanNotes = (v) =>
  typeof v === "string" ? v.normalize("NFKC").trim().replace(/\s+/g, " ").slice(0, MAX_ACCESS_NOTES_LENGTH) : "";

const statusOf = (order) => String(order?.statusKey ?? order?.status ?? "").trim().toLowerCase();

/** Where the order says the rider must arrive: canonical destination* first, clinic* for older orders. */
export function orderArrival(order) {
  const canonical = ["destinationLat", "destinationLng"].some((k) => order?.[k] !== undefined);
  return {
    lat: canonical ? order?.destinationLat : order?.clinicLat,
    lng: canonical ? order?.destinationLng : order?.clinicLng,
    radius: canonical ? order?.destinationGeofenceRadiusM : order?.clinicGeofenceRadiusM,
    notes: cleanNotes(order?.destinationAccessNotes),
    entrance: order?.destinationEntranceConfirmed === true,
  };
}

/**
 * What differs between the order's saved clinic destination and the clinic as
 * it is now, or null when nothing does (or it cannot be compared: not a clinic
 * destination, another clinic, or a clinic without a valid verified pin).
 *
 * @param {object} order   order document (raw fields)
 * @param {object} clinic  clinic document with its document `id`
 * @returns {null | { changes: string[], text: string, correctable: boolean }}
 */
export function clinicPinDrift(order, clinic) {
  if (!order || !clinic || typeof order.clinicDocId !== "string" || order.clinicDocId !== clinic.id) return null;
  if (order.destinationType && order.destinationType !== "clinic") return null;
  if (clinic.locationVerified !== true) return null;
  const location = validateClinicLocation(clinic);
  if (!location.ok) return null;
  const saved = orderArrival(order);
  const changes = [];
  if (saved.lat !== location.value.latitude || saved.lng !== location.value.longitude) changes.push("pin");
  if (saved.radius !== location.value.geofenceRadiusM) changes.push("arrival radius");
  if (saved.notes !== cleanNotes(clinic.accessNotes) || saved.entrance !== (clinic.entranceConfirmed === true)) {
    changes.push("entrance details");
  }
  if (changes.length === 0) return null;
  const correctable = CORRECTABLE_DESTINATION_STATUSES.includes(statusOf(order));
  const list = changes.length === 1 ? changes[0] : `${changes.slice(0, -1).join(", ")} and ${changes.at(-1)}`;
  return {
    changes,
    correctable,
    text: correctable
      ? `The clinic's ${list} changed after this order was placed. Request a change to use the corrected one.`
      : `The clinic's ${list} changed after this order was placed. Arrival is still checked against the order's saved point.`,
  };
}

/** Clinic documents by id, for clinicPinDrift lookups. */
export function clinicsById(clinics) {
  return new Map((clinics || []).filter((c) => typeof c?.id === "string").map((c) => [c.id, c]));
}

/**
 * A corrected destination clears the order's route and its trip's route
 * (destinationOperations approval). Until one is generated again, the order
 * has no route to follow or to monitor.
 */
export function routeNeedsRegenerating(order) {
  if (!order?.destinationCorrectedAt || !ROUTED_STATUSES.includes(statusOf(order))) return false;
  const hasRoute = typeof order.routePolyline === "string" && order.routePolyline !== "";
  const hasTrip = typeof order.tripPolyline === "string" && order.tripPolyline !== "";
  return !hasRoute && !hasTrip;
}

export const ROUTE_REGENERATE_TEXT = "Destination corrected — generate the route again (Plan trip or Generate route).";
