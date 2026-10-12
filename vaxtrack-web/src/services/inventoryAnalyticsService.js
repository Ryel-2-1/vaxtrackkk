import { collection, doc, limit, orderBy, query, serverTimestamp, setDoc } from "firebase/firestore";
import { auth, db } from "../firebase";
import { analyticsConfigPayload } from "./inventoryAnalytics";
import { UserMessageError } from "./userMessageError.js";
import { logSafeError } from "./liveDataErrors.js";
import { listenLive } from "./liveSnapshot.js";

/**
 * AI Inventory Analytics reads (Admin only — firestore.rules) and the ONE
 * client write: the per-vaccine reorder configuration. Forecasts and run
 * records are server-generated and read-only here; nothing in this file can
 * touch inventory, orders, reservations, prices or invoices.
 */

const FORECASTS = "inventoryForecasts";
const RUNS = "inventoryAnalyticsRuns";
const CONFIG = "inventoryAnalyticsConfig";

/** The most recent analytics run, or null when none has been generated. */
export function subscribeLatestAnalyticsRun(callback, onError) {
  return listenLive(
    query(collection(db, RUNS), orderBy("generatedAt", "desc"), limit(1)),
    (snap) => callback(snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() }),
    (err) => {
      logSafeError("Analytics run subscription", err);
      onError?.(err);
    }
  );
}

export function subscribeInventoryForecasts(callback, onError) {
  return listenLive(
    collection(db, FORECASTS),
    (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => {
      logSafeError("Inventory forecast subscription", err);
      onError?.(err);
    }
  );
}

/** Map vaccineId → stored configuration. */
export function subscribeAnalyticsConfigs(callback, onError) {
  return listenLive(
    collection(db, CONFIG),
    (snap) => callback(new Map(snap.docs.map((d) => [d.id, d.data()]))),
    (err) => {
      logSafeError("Analytics configuration subscription", err);
      onError?.(err);
    }
  );
}

/**
 * Save one vaccine's reorder configuration. Validated here and again by the
 * rules; stamped with server time and the signed-in Admin's uid (the rules
 * refuse any other uid or time). Takes effect at the NEXT analytics run.
 */
export async function saveAnalyticsConfig(vaccineId, form) {
  const checked = analyticsConfigPayload(vaccineId, form);
  if (!checked.ok) throw new UserMessageError(checked.error);
  const uid = auth.currentUser?.uid;
  if (!uid) throw new UserMessageError("You must be signed in to change analytics configuration.");
  await setDoc(doc(db, CONFIG, vaccineId), {
    ...checked.value,
    updatedAt: serverTimestamp(),
    updatedByUid: uid,
  });
}
