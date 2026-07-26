import {
  addDoc,
  collection,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { db } from "../firebase";

const CLINICS = "clinics";

export function subscribeClinics(callback, onError) {
  return onSnapshot(
    collection(db, CLINICS),
    (snap) => {
      const docs = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => {
          const aMs = a.createdAt?.toMillis?.() ?? 0;
          const bMs = b.createdAt?.toMillis?.() ?? 0;
          return bMs - aMs;
        });
      callback(docs);
    },
    (error) => {
      console.error("subscribeClinics error:", error);
      if (onError) onError(error);
    }
  );
}

export async function clinicNameExists(name) {
  const q = query(collection(db, CLINICS), where("name", "==", name.trim()));
  const snap = await getDocs(q);
  return !snap.empty;
}

export async function addClinic({
  clinicId,
  name,
  location,
  area,
  contact,
  phone,
  email,
  deliveryNotes,
  status,
  latitude,
  longitude,
}) {
  const clinic = {
    clinicId,
    name: name.trim(),
    location: location.trim(),
    area,
    contact: contact.trim(),
    phone: phone.trim(),
    email: email.trim(),
    deliveryNotes: deliveryNotes.trim(),
    status,
    lastDelivery: "No delivery yet",
    createdAt: serverTimestamp(),
  };

  // Optional manual coordinates — only stored when both are valid numbers.
  // Clinics without coordinates keep working exactly as before (no map pin,
  // no geofence circle). No geocoding API is used.
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng) &&
      latitude !== "" && longitude !== "") {
    clinic.latitude = lat;
    clinic.longitude = lng;
  }

  return addDoc(collection(db, CLINICS), clinic);
}
