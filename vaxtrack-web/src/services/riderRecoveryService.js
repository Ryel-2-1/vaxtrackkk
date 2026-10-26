import { getFunctions, httpsCallable } from "firebase/functions";
import app from "../firebase";
import { RiderDispatchError } from "./riderDispatchService.js";

/**
 * Client side of the Admin Rider recovery (functions/src/riderRecoveryOps.js).
 *
 * previewRiderRecovery is read-only and returns a `version` of everything the
 * server read. applyRiderRecovery sends ONLY the Rider, the action, that
 * version and a reason — never order ids, trip ids, statuses or custody — and
 * the server refuses (`recovery-stale`) if anything changed since the preview.
 * Re-checking a Rider stays recheckRiderTripStatesOnServer (riderDispatchService).
 */
const FUNCTIONS_REGION = "asia-southeast1";

function callables() {
  const fns = getFunctions(app, FUNCTIONS_REGION);
  return {
    preview: httpsCallable(fns, "previewRiderRecovery"),
    apply: httpsCallable(fns, "applyRiderRecovery"),
  };
}

function rethrow(error) {
  const details = error?.details;
  if (details && typeof details.code === "string") {
    throw new RiderDispatchError(details.code, error.message, details.info);
  }
  const code = typeof error?.code === "string" ? error.code.replace(/^functions\//, "") : "unavailable";
  if (code === "unauthenticated") {
    throw new RiderDispatchError(code, "Your session has expired. Please sign in again.");
  }
  if (code === "deadline-exceeded") {
    throw new RiderDispatchError(code, "The server took too long to respond. Refresh the rider's details before trying again.");
  }
  throw new RiderDispatchError(
    code === "unavailable" ? "unavailable" : "service-unavailable",
    "The rider recovery service is unavailable right now. Nothing was changed — please try again."
  );
}

/** The Rider's authoritative trip state, orders and available recoveries. */
export async function previewRiderRecovery(riderUid) {
  try {
    return (await callables().preview({ riderUid })).data;
  } catch (error) {
    return rethrow(error);
  }
}

/** action: "confirm_return" | "qa_reset". `version` is the preview's. */
export async function applyRiderRecovery({ riderUid, action, version, reason }) {
  try {
    return (await callables().apply({ riderUid, action, version, reason })).data;
  } catch (error) {
    return rethrow(error);
  }
}
