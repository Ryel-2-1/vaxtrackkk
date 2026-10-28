import { AlertTriangle, Route } from "lucide-react";
import { ROUTE_REGENERATE_TEXT, clinicPinDrift, routeNeedsRegenerating } from "../../services/destinationFreshness";
import "./DestinationNotes.css";

/**
 * Two notes about an order's destination, shown wherever Dispatch works with
 * it (Shipments, Geofence, Cargo Loading):
 *   - the clinic's pin/entrance was corrected after the order copied it, so the
 *     order still uses the old point (request a change to refresh it);
 *   - the destination was corrected and its route cleared, so a route must be
 *     generated again.
 * `clinic` is the clinic document (with `id`), or undefined.
 */
export default function DestinationNotes({ order, clinic }) {
  const drift = order?.destinationChangeRequest ? null : clinicPinDrift(order, clinic);
  const regenerate = routeNeedsRegenerating(order);
  if (!drift && !regenerate) return null;
  return (
    <>
      {drift && (
        <small className="destination-note" role="note">
          <AlertTriangle size={12} aria-hidden="true" />
          {drift.text}
        </small>
      )}
      {regenerate && (
        <small className="destination-note" role="note">
          <Route size={12} aria-hidden="true" />
          {ROUTE_REGENERATE_TEXT}
        </small>
      )}
    </>
  );
}
