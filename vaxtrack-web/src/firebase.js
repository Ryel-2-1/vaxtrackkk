// firebase.js

import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyBT6gNMM1KGtsqi4JjSpt8iyKAHqmtek58",
  authDomain: "vaxtrack-27044.firebaseapp.com",
  projectId: "vaxtrack-27044",
  storageBucket: "vaxtrack-27044.firebasestorage.app",
  messagingSenderId: "92953416605",
  appId: "1:92953416605:web:d2d9bd4fabc23e7da65574",
  measurementId: "G-664NTBNHWC",
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);

export default app;