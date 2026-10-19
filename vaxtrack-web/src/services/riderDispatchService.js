import { collection } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import app, { db } from "../firebase";
import { listenLive } from "./liveSnapshot.js";
import { UserMessageError } from "./userMessageError.js";
import { indexRiderStates } from "./riderTrip.js";

/**
 * Client side of Rider trips (functions/src/riderDispatchOps.js).
 *
 * Assigning a rider, Finalize Dispatch and confirming a Rider's return to the
 * hub are server callables: each reads the Rider's trip state in the same
 * transaction, which no client write can. firestore.rules refuse the direct
 * writes, Admin included. The trip state is read live from
 * `riderDispatchStates` (server-written only).
 */
const FUNCTIONS_REGION = "asia-southeast1";
const RIDER_DISPATCH_STATES = "riderDispatchStates";

function callables() {
  const fns = getFunctions(app, FUNCTIONS_REGION);
  return {
    assign: httpsCallable(fns, "assignRiderToOrder"),
    finalize: httpsCallable(fns, "finalizeRiderDispatch"),
    confirmReturn: httpsCallable(fns, "confirmRiderReturnToHub"),
  };
}

/**
 * A refusal from a trip callable, carrying the server's stable code
 * (`rider-on-trip`, `trip-changed`, `order-not-pending`, …). The message is the
 * sentence the server wrote for the Dispatcher; `details` is any context it
 * returned (e.g. the status an order was found in), never shown raw.
 */
export class RiderDispatchError extends UserMessageError {
  constructor(code, message, details) {
    super(message);
    this.name = "RiderDispatchError";
    this.code = code;
    this.details = details ?? null;
  }
}

function rethrow(error) {
  const details = error?.details;
  if (details && typeof details.code === "string") {
    throw new RiderDispatchError(details.code, error.message, details.info);
  }
  // Not a domain refusal: the transport. Keep the transport code (the pages
  // already word `unavailable`, `deadline-exceeded`, `unauthenticated`) and
  // never pass the raw text through.
  const code = typeof error?.code === "string" ? error.code.replace(/^functions\//, "") : "unavailable";
  if (code === "unauthenticated") {
    throw new RiderDispatchError(code, "Your session has expired. Please sign in again.");
  }
  if (code === "deadline-exceeded") {
    throw new RiderDispatchError(code, "The server took too long to respond. Check the list before trying again.");
  }
  throw new RiderDispatchError(
    code === "unavailable" ? "unavailable" : "service-unavailable",
    "The dispatch service is unavailable right now. Nothing was changed — please try again."
  );
}

/** pending_dispatch → assigned; the order joins the Rider's forming trip (or starts one). */
export async function assignRiderToOrderOnServer(orderId, riderUid) {
  try {
    return (await callables().assign({ orderId, riderUid })).data;
  } catch (error) {
    return rethrow(error);
  }
}

/** The Rider's whole forming trip: loading → in_transit, at once. */
export async function finalizeRiderTripOnServer({ riderUid, orderIds, tripId = null }) {
  try {
    return (await callables().finalize({ riderUid, orderIds, ...(tripId ? { tripId } : {}) })).data;
  } catch (error) {
    return rethrow(error);
  }
}

/** returning_to_hub → available_at_hub, after the Rider is physically back. */
export async function confirmRiderReturnToHub({ riderUid, tripId }) {
  try {
    return (await callables().confirmReturn({ riderUid, tripId })).data;
  } catch (error) {
    return rethrow(error);
  }
}

/** Live map riderUid → trip state document (Dispatcher / Admin only). */
export function subscribeRiderDispatchStates(callback, onError) {
  return listenLive(
    collection(db, RIDER_DISPATCH_STATES),
    // Document id last, so a stray stored `id` field can never shadow it.
    (snapshot) => callback(indexRiderStates(snapshot.docs.map((d) => ({ ...d.data(), id: d.id })))),
    onError
  );
}
