// Explicit development mode only. Never inherit real Firebase credentials.
export const MOTORCYCLE_QA_PROJECT = "demo-vaxtrack-motorcycle";
export function motorcycleQaConfig({ mode, dev, hostname }) {
  if (mode !== "motorcycle-qa") return null;
  if (!dev || !["localhost", "127.0.0.1", "[::1]"].includes(hostname)) {
    throw new Error("Motorcycle QA must run on a local development server.");
  }
  return {
    apiKey: "local-motorcycle-qa",
    authDomain: `${MOTORCYCLE_QA_PROJECT}.firebaseapp.com`,
    projectId: MOTORCYCLE_QA_PROJECT,
    storageBucket: `${MOTORCYCLE_QA_PROJECT}.appspot.com`,
    messagingSenderId: "1234567890",
    appId: "1:1234567890:web:motorcycle-qa",
  };
}
