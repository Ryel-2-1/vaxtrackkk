import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { auth, db } from "../firebase";
import { validateStockCorrection } from "./stockCorrection";
import { validateStockBatchDates } from "./stockBatchDates";
import { readVatClassification } from "./vatClassification";
import { PRICES_INCLUDE_VAT } from "./pricingConfig";

const VACCINES = "vaccines";
const VACCINE_TYPES = "vaccineTypes";
const INVENTORY = "inventory";

export async function getVaccineTypes() {
  const q = query(collection(db, VACCINE_TYPES), orderBy("name", "asc"));
  const snap = await getDocs(q);
  // Document id LAST so it always wins. Add Vaccine keys its dropdown options
  // by this value, and two types carrying the same stored `id` would collapse
  // into a single option.
  return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
}

export async function addVaccineType(name) {
  return addDoc(collection(db, VACCINE_TYPES), { name, createdAt: serverTimestamp() });
}

export async function skuExists(sku) {
  const q = query(collection(db, VACCINES), where("internalSku", "==", sku));
  const snap = await getDocs(q);
  return !snap.empty;
}

/**
 * Register a vaccine product. `vatClassification` is REQUIRED — exactly
 * "vatable" or "vat_exempt", chosen by the Admin, never defaulted. It becomes
 * the snapshot copied onto every future order item for this vaccine.
 */
export async function addVaccine({ vaccineName, manufacturer, vaccineType, internalSku, vatClassification }) {
  const cls = readVatClassification(vatClassification);
  if (!cls) {
    throw new Error("Select VAT or VAT Exempt for this vaccine.");
  }
  return addDoc(collection(db, VACCINES), {
    vaccineName,
    manufacturer,
    vaccineType,
    internalSku,
    vatClassification: cls,
    createdAt: serverTimestamp(),
  });
}

/**
 * Admin: set or correct a vaccine product's VAT classification.
 *
 * Affects only FUTURE order items — each existing order item keeps the
 * snapshot it was created with, and issued invoices are never touched. WHO and
 * WHEN are recorded from the session, never from a parameter (the same
 * convention as re-pricing); firestore.rules pins both.
 */
export async function setVaccineVatClassification(vaccineId, vatClassification) {
  const cls = readVatClassification(vatClassification);
  if (!cls) {
    throw new Error("Select VAT or VAT Exempt for this vaccine.");
  }
  const uid = auth.currentUser?.uid;
  if (!uid) {
    throw new Error("Your session has expired. Please sign in again.");
  }
  if (typeof vaccineId !== "string" || !vaccineId || vaccineId.includes("/")) {
    throw new Error("That vaccine could not be identified.");
  }
  return updateDoc(doc(db, VACCINES, vaccineId), {
    vatClassification: cls,
    vatClassificationSetAt: serverTimestamp(),
    vatClassificationSetByUid: uid,
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
 * Add one stock batch to inventory — through the TRUSTED server callable.
 *
 * Inventory documents can no longer be created by a client at all (the rules
 * refuse every create): a new batch must, in the same transaction, be reserved
 * for waiting future orders in priority order, and a client cannot be trusted
 * to do that or to set its own reserved figure. So this validates exactly as
 * before (nothing invalid leaves the page), then hands `submit` — the
 * `addStockBatchWithAllocation` callable in the app, a fake in tests — ONLY
 * the fields the server accepts. Catalog details (name, type, SKU) and the
 * batch status are read server-side from the vaccine document and the expiry.
 *
 * NO STORAGE TEMPERATURE. Add Stock no longer collects one, so none is sent.
 *
 * Resolves the server's report: `{ inventoryId, batchId, status, added,
 * allocatedToOrders, leftAvailable, allocations }`.
 */
export async function addStockBatch({
  vaccineId,
  manufacturer,
  batchId,
  manufacturingDate,
  arrivalDate,
  expiryDate,
  quantity,
  sellingPriceCentavos,
}, { todayIso, submit } = {}) {
  if (typeof submit !== "function") {
    throw new Error("Stock can only be added through the server.");
  }
  // The batch's dates, re-checked here so nothing invalid is even sent:
  // manufacturing present, real, not in the future (Asia/Manila), on/before
  // arrival and before expiry; plus the existing arrival/expiry rules.
  // Date-only strings, never browser Dates. The server repeats all of it.
  // `todayIso` exists for tests; the app always uses today in Manila.
  const dates = validateStockBatchDates({ manufacturingDate, arrivalDate, expiryDate, todayIso });
  if (!dates.ok) {
    throw new Error(dates.message);
  }
  // A price that reaches the server as a float, a string or a zero is refused
  // there too; the cheapest place to stop it is before the call.
  if (
    !Number.isInteger(sellingPriceCentavos) ||
    !Number.isSafeInteger(sellingPriceCentavos) ||
    sellingPriceCentavos <= 0
  ) {
    throw new Error("A stock batch needs a selling price in whole centavos.");
  }
  return submit({
    vaccineId,
    batchId,
    // Date-only 'YYYY-MM-DD' strings — the canonical, validated values.
    manufacturingDate: dates.value.manufacturingDate,
    arrivalDate: dates.value.arrivalDate,
    expiryDate: dates.value.expiryDate,
    quantity,
    // The clinic selling price for this batch, in PHP centavos — VAT-inclusive
    // for VATable products (the server stamps the convention).
    sellingPriceCentavos,
    ...(typeof manufacturer === "string" && manufacturer.trim() ? { manufacturer: manufacturer.trim() } : {}),
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
    // Entered prices are VAT-inclusive (pricingConfig.js).
    priceIsVatInclusive: PRICES_INCLUDE_VAT,
    // Audit taken from the SESSION, never from a parameter. A caller-supplied
    // uid would let one admin record a re-price as another's — and the rules
    // now refuse any value that is not the authenticated caller, so passing one
    // could only ever fail. `serverTimestamp()` resolves to `request.time`,
    // which the rules pin for the same reason: a client clock is not evidence.
    priceSetAt: serverTimestamp(),
    priceSetByUid: auth.currentUser?.uid ?? null,
  });
}

/**
 * Correct a batch's on-hand quantity — the admin fix for a human error in Add
 * Stock or in a batch's recorded figure.
 *
 * The batch is read fresh here, so `previousQuantity` and the reserved-floor
 * check reflect what Firestore actually holds, not a possibly-stale row on
 * screen. Only `quantity` and its audit fields are written; `reservedQuantity`
 * is never touched, and the value can never drop below what is reserved — the
 * same bound the Firestore rules enforce, so a stale attempt fails there too.
 * WHO/WHEN come from the session and the server clock, never from a parameter.
 */
export async function correctStockQuantity({ inventoryId, newQuantity, reason }) {
  if (typeof inventoryId !== "string" || inventoryId.trim() === "") {
    throw new Error("A batch is required to correct its stock.");
  }

  const ref = doc(db, INVENTORY, inventoryId);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    throw new Error("That batch no longer exists.");
  }
  const prev = snap.data();

  const check = validateStockCorrection({
    newQuantity,
    currentQuantity: prev.quantity,
    reservedQuantity: prev.reservedQuantity,
    returnPendingQuantity: prev.returnPendingQuantity,
    quarantinedQuantity: prev.quarantinedQuantity,
    reason,
  });
  if (!check.ok) {
    throw new Error(check.message);
  }

  return updateDoc(ref, {
    quantity: check.value.newQuantity,
    // Record the prior value exactly as stored (even a corrupt text figure), so
    // the correction is auditable and the rules can verify it is honest.
    previousQuantity: prev.quantity ?? null,
    quantityCorrectionReason: check.value.reason,
    quantityCorrectedAt: serverTimestamp(),
    quantityCorrectedByUid: auth.currentUser?.uid ?? null,
    quantityCorrectedByEmail: auth.currentUser?.email ?? null,
    updatedAt: serverTimestamp(),
  });
}
