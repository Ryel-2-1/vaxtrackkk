import {
  addDoc,
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { auth, db } from "../firebase";

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
  sellingPriceCentavos,
  status,
}) {
  // Refused here as well as in the rules and the callable. A price that reaches
  // Firestore as a float, a string or a zero is a price that will eventually be
  // read as one, and the cheapest place to stop it is before the write.
  if (
    !Number.isInteger(sellingPriceCentavos) ||
    !Number.isSafeInteger(sellingPriceCentavos) ||
    sellingPriceCentavos <= 0
  ) {
    throw new Error("A stock batch needs a selling price in whole centavos.");
  }
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
    // Every batch starts with nothing reserved.
    //
    // Absent used to mean "treat as zero", which was fine while nothing
    // reserved anything. Now that availability is `quantity - reservedQuantity`
    // the field has to exist from the batch's first moment: firestore.rules
    // requires it to be exactly 0 on create, and the callable refuses a batch
    // whose reserved figure is present but not a non-negative integer.
    reservedQuantity: 0,
    // The VAT-EXCLUSIVE clinic selling price for this batch, in PHP centavos.
    // Price belongs to the BATCH rather than the vaccine because the same
    // vaccine bought in two procurement lots can legitimately sell at two
    // prices, and a product-level field could not express that.
    sellingPriceCentavos,
    priceCurrency: "PHP",
    priceIsVatInclusive: false,
    status,
    createdAt: serverTimestamp(),
  });
}

/**
 * Re-price an existing batch.
 *
 * FORWARD-ONLY. This changes what future orders will be quoted; it never
 * reaches back into an order that has already been placed, because those carry
 * their own immutable snapshot of what was actually agreed.
 *
 * `quantity` and `reservedQuantity` are untouched and unreachable from here —
 * the rules refuse a client write that names either, so re-pricing can never
 * become a way to move stock.
 */
export async function updateStockPrice({ inventoryId, sellingPriceCentavos }) {
  if (typeof inventoryId !== "string" || inventoryId.trim() === "") {
    throw new Error("A batch is required to set a price.");
  }
  if (
    !Number.isInteger(sellingPriceCentavos) ||
    !Number.isSafeInteger(sellingPriceCentavos) ||
    sellingPriceCentavos <= 0
  ) {
    throw new Error("A selling price must be a whole number of centavos above zero.");
  }
  return updateDoc(doc(db, INVENTORY, inventoryId), {
    sellingPriceCentavos,
    priceCurrency: "PHP",
    priceIsVatInclusive: false,
    // Audit taken from the SESSION, never from a parameter. A caller-supplied
    // uid would let one admin record a re-price as another's — and the rules
    // now refuse any value that is not the authenticated caller, so passing one
    // could only ever fail. `serverTimestamp()` resolves to `request.time`,
    // which the rules pin for the same reason: a client clock is not evidence.
    priceSetAt: serverTimestamp(),
    priceSetByUid: auth.currentUser?.uid ?? null,
  });
}
