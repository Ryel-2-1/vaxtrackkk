import { getFunctions, httpsCallable } from "firebase/functions";
import app from "../firebase";

/** Read current owner names for the visible orders, without a staff-directory read. */
export async function fetchOrderMedRepNames(orderIds) {
  if (!Array.isArray(orderIds) || orderIds.length === 0) return {};
  const call = httpsCallable(getFunctions(app, "asia-southeast1"), "getOrderMedRepNames");
  const result = await call({ orderIds });
  const names = result.data?.names;
  if (!names || typeof names !== "object" || Array.isArray(names)) return {};
  return Object.fromEntries(orderIds.flatMap((id) =>
    typeof names[id] === "string" && names[id].trim() ? [[id, names[id].trim()]] : []
  ));
}
