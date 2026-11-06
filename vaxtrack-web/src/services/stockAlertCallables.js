import { getFunctions, httpsCallable } from "firebase/functions";
import app from "../firebase";
import { UserMessageError } from "./userMessageError.js";

/**
 * Admin "Check stock now" (functions/src/stockAlertsOps.js recheckStockAlerts):
 * re-runs the stock and expiry alert review across every vaccine. The same
 * review runs on every stock change and in the daily inventory review; this
 * lets an Admin refresh expiry alerts without waiting for either.
 */
const FUNCTIONS_REGION = "asia-southeast1";

export class StockAlertError extends UserMessageError {
  constructor(code, message) {
    super(message, { code });
    this.name = "StockAlertError";
  }
}

/** → { checked, changed, failed }. */
export async function recheckStockAlerts() {
  try {
    return (await httpsCallable(getFunctions(app, FUNCTIONS_REGION), "recheckStockAlerts")({})).data;
  } catch (error) {
    const details = error?.details;
    if (details && typeof details.code === "string") throw new StockAlertError(details.code, error.message);
    throw new StockAlertError("service-unavailable", "Stock could not be checked right now. Please try again.");
  }
}
