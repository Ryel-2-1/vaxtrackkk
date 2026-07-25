import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// Firebase config is read from Vite env vars (.env / .env.local / .env.<mode>),
// never hardcoded — so development, staging, and production can point at
// different Firebase projects without any code change. Copy `.env.example` to
// `.env` and fill in the values (Firebase console -> Project settings -> SDK
// setup). `.env` is gitignored; only `.env.example` is committed.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

// Fail fast with a clear message (naming the missing KEYS, never the values) if
// a required var is absent, instead of letting Firebase throw an opaque error
// on first use. measurementId is optional (Analytics, production only).
const requiredEnv = {
  VITE_FIREBASE_API_KEY: firebaseConfig.apiKey,
  VITE_FIREBASE_AUTH_DOMAIN: firebaseConfig.authDomain,
  VITE_FIREBASE_PROJECT_ID: firebaseConfig.projectId,
  VITE_FIREBASE_STORAGE_BUCKET: firebaseConfig.storageBucket,
  VITE_FIREBASE_MESSAGING_SENDER_ID: firebaseConfig.messagingSenderId,
  VITE_FIREBASE_APP_ID: firebaseConfig.appId,
};
const missingEnv = Object.keys(requiredEnv).filter((k) => !requiredEnv[k]);
if (missingEnv.length > 0) {
  throw new Error(
    `Firebase config is missing required env vars: ${missingEnv.join(", ")}. ` +
      "Copy .env.example to .env and fill in the values (see CLAUDE.md)."
  );
}

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
