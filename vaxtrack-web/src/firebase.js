// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDQfnN4cg58Ym7M4IqWRnapK-k_k_wbqCg",
  authDomain: "vaxtrack-bef1b.firebaseapp.com",
  projectId: "vaxtrack-bef1b",
  storageBucket: "vaxtrack-bef1b.firebasestorage.app",
  messagingSenderId: "1023801727166",
  appId: "1:1023801727166:web:1f265e5766b35c5eb166ef",
  measurementId: "G-24PNWHK97G"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);