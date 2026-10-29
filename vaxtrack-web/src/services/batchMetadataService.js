import { getFunctions, httpsCallable } from "firebase/functions";
import app from "../firebase";

export async function saveBatchMetadata(payload) {
  const call = httpsCallable(getFunctions(app, "asia-southeast1"), "updateBatchMetadata");
  const result = await call(payload);
  return result.data;
}
