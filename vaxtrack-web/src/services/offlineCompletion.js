/** Offline delivery completion — the Dispatcher/Admin review call (helpers: offlineCompletionView.js). */
import { getFunctions, httpsCallable } from "firebase/functions";
import app from "../firebase";
import { UserMessageError } from "./userMessageError.js";

export * from "./offlineCompletionView.js";

/** Approve or reject an offline record waiting for review. Rejecting needs a reason. */
export async function resolveOfflineCompletion(orderId, decision, note = "") {
  try {
    const call = httpsCallable(getFunctions(app, "asia-southeast1"), "resolveOfflineCompletionReview");
    const result = await call({ orderId, decision, ...(note.trim() ? { note: note.trim() } : {}) });
    return result.data;
  } catch (error) {
    if (typeof error?.details?.code === "string") {
      throw new UserMessageError(error.message, { code: error.details.code, cause: error });
    }
    throw new UserMessageError(
      error?.code === "functions/unauthenticated"
        ? "Your session has expired. Please sign in again."
        : "The review could not be saved right now. Nothing was changed — please try again.",
      { code: error?.code === "functions/unauthenticated" ? "unauthenticated" : "service-unavailable", cause: error }
    );
  }
}
