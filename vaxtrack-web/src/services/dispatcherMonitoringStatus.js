import { locationFreshness } from "./riderTracking.js";

/** Describe what the live tracking panel actually knows right now. */
export function dispatcherMonitoringStatus({ view, fleet = [], nowMs, deviationError = false }) {
  if (view === "permission" || view === "error") {
    return { tone: "error", label: "Tracking unavailable", detail: "Rider locations could not be loaded" };
  }
  if (view === "loading") {
    return { tone: "waiting", label: "Connecting", detail: "Checking Rider locations" };
  }
  if (view === "empty") {
    return { tone: "idle", label: "No Riders to track", detail: "Active assignments appear here" };
  }

  const total = fleet.length;
  const fresh = fleet.filter((rider) => locationFreshness(rider.location, nowMs) === "fresh").length;
  if (fresh === 0) {
    return { tone: "waiting", label: "Awaiting Rider GPS", detail: total ? `${total} Rider${total === 1 ? "" : "s"} assigned or on trip · no fresh location` : "No fresh location yet" };
  }
  if (fresh < total || deviationError) {
    return {
      tone: "partial",
      label: `${fresh} of ${total} Riders updating`,
      detail: deviationError ? "Route status unavailable; GPS positions still updating" : "Some Rider locations are not current",
    };
  }
  return { tone: "live", label: `${fresh} Rider${fresh === 1 ? "" : "s"} updating`, detail: "Recent GPS locations received" };
}
