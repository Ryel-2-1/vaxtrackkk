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
}) {
  return addDoc(collection(db, CLINICS), {
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
  });
}
