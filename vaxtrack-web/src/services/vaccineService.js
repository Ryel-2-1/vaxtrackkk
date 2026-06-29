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
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function batchIdExists(batchId) {
  const q = query(collection(db, INVENTORY), where("batchId", "==", batchId));
  const snap = await getDocs(q);
  return !snap.empty;
}

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
  storageTemp,
  storageTempDisplay,
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
    storageTemp,
    storageTempDisplay,
    status,
    createdAt: serverTimestamp(),
  });
}
