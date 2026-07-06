// TEMPORARY diagnostic module — delete after rider registration debug.
import {
  createUserWithEmailAndPassword,
  deleteUser,
  signInWithEmailAndPassword,
} from "firebase/auth";
import { deleteDoc, doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { auth, db } from "../firebase";

export async function diagRiderCreate(email, password) {
  const results = {};
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    results.authCreated = cred.user.uid;
    try {
      await setDoc(doc(db, "users", cred.user.uid), {
        role: "rider",
        status: "pending",
        fullName: "Diag Test",
        email,
        phone: "0000000000",
        vehiclePlate: "TEST-000",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      results.firestoreWrite = "success";
      const snap = await getDoc(doc(db, "users", cred.user.uid));
      results.readBack = snap.exists() ? `${snap.data().role}/${snap.data().status}` : "missing";
      await deleteDoc(doc(db, "users", cred.user.uid)).catch((e) => {
        results.docCleanup = e.code || String(e);
      });
    } catch (e) {
      results.firestoreWrite = e.code || String(e);
    }
    await deleteUser(cred.user).catch((e) => {
      results.authCleanup = e.code || String(e);
    });
  } catch (e) {
    results.authCreated = e.code || String(e);
  }
  return results;
}

export async function diagSignIn(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user.email;
}
