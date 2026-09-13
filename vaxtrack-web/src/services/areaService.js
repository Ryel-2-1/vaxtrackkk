import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import { db } from "../firebase";
import { validateAreaName } from "./areaModel";

const AREAS = "areas";

export function subscribeAreas(callback, onError) {
  return onSnapshot(
    collection(db, AREAS),
    (snapshot) => {
      const areas = snapshot.docs
        // Firestore document id LAST: a stored `id` field cannot redirect a
        // clinic or doctor that later references this area.
        .map((area) => ({ ...area.data(), id: area.id }))
        .sort((a, b) => {
          if (Boolean(a.active) !== Boolean(b.active)) {
            return a.active ? -1 : 1;
          }
          return String(a.name || "").localeCompare(String(b.name || ""));
        });
      callback(areas);
    },
    (error) => {
      console.error("subscribeAreas error:", error);
      if (onError) onError(error);
    }
  );
}

export async function addArea(name) {
  const check = validateAreaName(name);
  if (!check.ok) throw new Error(check.error);

  const { key, name: displayName, nameNormalized } = check.value;
  const ref = doc(db, AREAS, key);

  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (snapshot.exists()) {
      const error = new Error("An area with this name already exists.");
      error.code = "area-already-exists";
      throw error;
    }

    transaction.set(ref, {
      key,
      name: displayName,
      nameNormalized,
      active: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });

  return ref;
}

export async function setAreaActive(areaId, active) {
  const id = typeof areaId === "string" ? areaId.trim() : "";
  if (!id || id.includes("/")) {
    throw new Error("That area could not be identified.");
  }
  if (typeof active !== "boolean") {
    throw new Error("Area status must be active or inactive.");
  }

  const ref = doc(db, AREAS, id);
  const snapshot = await getDoc(ref);
  if (!snapshot.exists()) {
    throw new Error("That area no longer exists.");
  }

  await updateDoc(ref, {
    active,
    updatedAt: serverTimestamp(),
  });
}
