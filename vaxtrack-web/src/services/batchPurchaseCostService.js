import { doc, getDocFromServer } from "firebase/firestore";
import { db } from "../firebase";

export async function getBatchPurchaseCost(inventoryId) {
  const snapshot = await getDocFromServer(doc(db, "inventoryBatchCosts", inventoryId));
  if (!snapshot.exists()) return null;
  const cost = snapshot.data().purchaseCostCentavos;
  if (!Number.isSafeInteger(cost) || cost < 0) throw new Error("Invalid batch purchase cost.");
  return cost;
}
