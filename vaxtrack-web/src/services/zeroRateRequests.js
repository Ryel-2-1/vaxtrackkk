import { collection, query, where } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import app, { db } from "../firebase";
import { listenLive } from "./liveSnapshot";
import { UserMessageError } from "./userMessageError";

const requests = collection(db, "zeroRateRequests");

function subscribe(q, onData, onError) {
  return listenLive(q, (snapshot) => onData(snapshot.docs.map((doc) => ({ ...doc.data(), id: doc.id }))), onError);
}

export function subscribeOwnZeroRateRequests(uid, onData, onError) {
  return subscribe(query(requests, where("requesterUid", "==", uid)), onData, onError);
}

export function subscribePendingZeroRateRequests(onData, onError) {
  return subscribe(query(requests, where("status", "==", "pending")), onData, onError);
}

async function call(name, payload) {
  try {
    const result = await httpsCallable(getFunctions(app, "asia-southeast1"), name)(payload);
    return result.data;
  } catch (error) {
    if (typeof error?.details?.code === "string") {
      throw new UserMessageError(error.message, { code: error.details.code });
    }
    throw error;
  }
}

export const requestZeroRateApproval = (payload) => call("requestZeroRateApproval", payload);
export const reviewZeroRateApproval = (payload) => call("reviewZeroRateApproval", payload);
