import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDQfnN4cg58Ym7M4IqWRnapK-k_k_wbqCg",
  authDomain: "vaxtrack-bef1b.firebaseapp.com",
  projectId: "vaxtrack-bef1b",
  storageBucket: "vaxtrack-bef1b.firebasestorage.app",
  messagingSenderId: "1023801727166",
  appId: "1:1023801727166:web:1f265e5766b35c5eb166ef",
  measurementId: "G-24PNWHK97G",
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);

if (import.meta.env.PROD) {
  import("firebase/analytics").then(({ getAnalytics, isSupported }) => {
    isSupported().then((supported) => {
      if (supported) getAnalytics(app);
    });
  });
}

export default app;