import { getFunctions, httpsCallable } from "firebase/functions";
import app from "../firebase";

export async function fetchCancelledShipmentAudit(orderId) {
  const call = httpsCallable(getFunctions(app, "asia-southeast1"), "getCancelledShipmentAudit");
  const result = await call({ orderId });
  return result.data;
}
