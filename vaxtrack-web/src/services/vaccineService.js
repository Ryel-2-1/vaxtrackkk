import {
  addDoc,
  collection,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { db } from "../firebase";

const VACCINES = "vaccines";
const VACCINE_TYPES = "vaccineTypes";
const INVENTORY = "inventory";

export async function getVaccineTypes() {
  const q = query(collection(db, VACCINE_TYPES), orderBy("name", "asc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function addVaccineType(name) {
  return addDoc(collection(db, VACCINE_TYPES), { name, createdAt: serverTimestamp() });
}

export async function skuExists(sku) {
  const q = query(collection(db, VACCINES), where("internalSku", "==", sku));
  const snap = await getDocs(q);
  return !snap.empty;
}

export async function addVaccine({ vaccineName, manufacturer, vaccineType, internalSku }) {
  return addDoc(collection(db, VACCINES), {
    vaccineName,
    manufacturer,
    vaccineType,
    internalSku,
    createdAt: serverTimestamp(),
  });
}

export async function getVaccines() {
  const q = query(collection(db, VACCINES), orderBy("createdAt", "desc"));
  const snap = await getDocs(q);
  // Document id LAST so it always wins: a stored field named `id` must never
  // shadow the real document id. That id is the vaccine's authoritative
  // identity and is written onto each stock batch as `vaccineId`, so it must
  // never be conflated with the SKU, name or any business identifier.
  return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
}

export async function batchIdExists(batchId) {
  const q = query(collection(db, INVENTORY), where("batchId", "==", batchId));
  const snap = await getDocs(q);
  return !snap.empty;
}

/**
 * Add one stock batch to inventory.
 *
 * NO STORAGE TEMPERATURE. Add Stock no longer collects one, so none is written
 * — better than storing a placeholder that would read as a real cold-chain
 * figure. Dropping the parameters here is required rather than cosmetic:
 * `addDoc` rejects `undefined` values, so leaving them in the signature would
 * break the write the moment the caller stopped passing them.
 *
 * Existing inventory documents are untouched. Every reader — Admin Inventory,
 * Sales Rep Inventory, Sales Rep Request Order — already falls back to "—" when
 * the field is absent, so legacy batches keep showing their recorded
 * temperature and new ones simply show none.
 */
export async function addStockBatch({
  vaccineId,
  vaccineName,
  vaccineType,
  manufacturer,
  internalSku,
  batchId,
  arrivalDate,
  expiryDate,
  quantity,
  status,
}) {
  return addDoc(collection(db, INVENTORY), {
    vaccineId,
    vaccineName,
    vaccineType,
    manufacturer,
    internalSku: internalSku || "",
    batchId,
    arrivalDate,
    expiryDate,
    quantity,
    status,
    createdAt: serverTimestamp(),
  });
}
