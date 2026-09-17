import { collection, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import app, { db } from "../firebase";

export const MAX_DESTINATION_REASON_LENGTH = 500;

async function callDestinationFunction(name, payload) {
  try {
    const callable = httpsCallable(getFunctions(app, "asia-southeast1"), name);
    const result = await callable(payload);
    return result.data;
  } catch (error) {
    if (typeof error?.details?.code === "string") {
      const failure = new Error(error.message);
      failure.code = error.details.code;
      throw failure;
    }
    throw new Error(
      error?.code === "functions/unauthenticated"
        ? "Your session has expired. Please sign in again."
        : "Destination review is unavailable. Please try again."
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
  return onSnapshot(history, (snapshot) => {
    onData(snapshot.docs.map((item) => ({ ...item.data(), id: item.id })));
  }, onError);
}
