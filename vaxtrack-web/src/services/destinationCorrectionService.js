import { collection, limit, orderBy, query } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import app, { db } from "../firebase";
import { UserMessageError } from "./userMessageError.js";
import { listenLive } from "./liveSnapshot.js";

export const MAX_DESTINATION_REASON_LENGTH = 500;

async function callDestinationFunction(name, payload) {
  try {
    const callable = httpsCallable(getFunctions(app, "asia-southeast1"), name);
    const result = await callable(payload);
    return result.data;
  } catch (error) {
    // A domain refusal carries the server's stable code and its sentence for
    // the operator; anything else (network, an unexpected server failure) is
    // replaced with a safe sentence — its own text never reaches the screen.
    if (typeof error?.details?.code === "string") {
      throw new UserMessageError(error.message, { code: error.details.code, cause: error });
    }
    throw new UserMessageError(
      error?.code === "functions/unauthenticated"
        ? "Your session has expired. Please sign in again."
        : "Destination review is unavailable right now. Nothing was changed — please try again.",
      { code: error?.code === "functions/unauthenticated" ? "unauthenticated" : "service-unavailable", cause: error }
    );
  }
}

export function requestOrderDestinationChange(orderId, doctorAddressId, reason, expectedRevision) {
  return callDestinationFunction("requestOrderDestinationChange", {
    orderId, doctorAddressId, reason, expectedRevision,
  });
}

export function reviewOrderDestinationChange(orderId, requestId, decision) {
  return callDestinationFunction("reviewOrderDestinationChange", {
    orderId, requestId, decision,
  });
}

export function subscribeDestinationCorrections(orderId, onData, onError) {
  const history = query(
    collection(db, "orders", orderId, "destinationCorrections"),
    orderBy("revision", "desc"),
    limit(10)
  );
  return listenLive(history, (snapshot) => {
    onData(snapshot.docs.map((item) => ({ ...item.data(), id: item.id })));
  }, onError);
}
