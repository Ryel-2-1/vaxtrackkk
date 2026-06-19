
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
const firebaseConfig = {
  apiKey: "AIzaSyDQfnN4cg58Ym7M4IqWRnapK-k_k_wbqCg",
  authDomain: "vaxtrack-bef1b.firebaseapp.com",
  projectId: "vaxtrack-bef1b",
  storageBucket: "vaxtrack-bef1b.firebasestorage.app",
  messagingSenderId: "1023801727166",
  appId: "1:1023801727166:web:1f265e5766b35c5eb166ef",
  measurementId: "G-24PNWHK97G"
};
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);