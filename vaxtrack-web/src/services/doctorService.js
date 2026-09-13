import {
  collection,
  doc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "../firebase";
import { validateDoctorName } from "./doctorModel";

const DOCTORS = "doctors";
const AREAS = "areas";

export function subscribeDoctors(callback, onError) {
  return onSnapshot(
    collection(db, DOCTORS),
    (snapshot) => {
      const doctors = snapshot.docs
        // Firestore document id LAST: stored data can never redirect a later
        // delivery-location or order reference to another doctor.
        .map((doctor) => ({ ...doctor.data(), id: doctor.id }))
        .sort((a, b) => {
          if (Boolean(a.active) !== Boolean(b.active)) {
            return a.active ? -1 : 1;
          }
          const byName = String(a.name || "").localeCompare(
            String(b.name || "")
          );
          if (byName !== 0) return byName;
          return String(a.area || "").localeCompare(String(b.area || ""));
        });
      callback(doctors);
    },
    (error) => {
      console.error("subscribeDoctors error:", error);
      if (onError) onError(error);
    }
  );
}

export async function addDoctor({ name, areaId }) {
  const check = validateDoctorName(name);
  if (!check.ok) throw new Error(check.error);

  const stableAreaId = typeof areaId === "string" ? areaId.trim() : "";
  if (!stableAreaId || stableAreaId.includes("/")) {
    throw new Error("Select an active primary area for this doctor.");
  }

  // Auto-id is deliberate: two real doctors may share the same name. The
  // Firestore document id, not the display name, is their stable identity.
  const doctorRef = doc(collection(db, DOCTORS));
  const areaRef = doc(db, AREAS, stableAreaId);

  await runTransaction(db, async (transaction) => {
    const areaSnapshot = await transaction.get(areaRef);
    if (!areaSnapshot.exists() || areaSnapshot.data().active !== true) {
      throw new Error("Select an active primary area for this doctor.");
    }

    const areaName = String(areaSnapshot.data().name || "").trim();
    if (!areaName) {
      throw new Error("That area's name is unavailable.");
    }

    transaction.set(doctorRef, {
      name: check.value.name,
      nameNormalized: check.value.nameNormalized,
      areaId: stableAreaId,
      area: areaName,
      active: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });

  return doctorRef;
}

export async function setDoctorActive(doctorId, active) {
  const id = typeof doctorId === "string" ? doctorId.trim() : "";
  if (!id || id.includes("/")) {
    throw new Error("That doctor could not be identified.");
  }
  if (typeof active !== "boolean") {
    throw new Error("Doctor status must be active or inactive.");
  }

  const ref = doc(db, DOCTORS, id);
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists()) {
      throw new Error("That doctor no longer exists.");
    }

    transaction.update(ref, {
      active,
      updatedAt: serverTimestamp(),
    });
  });
}
