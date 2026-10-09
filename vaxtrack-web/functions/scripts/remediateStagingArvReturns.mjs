/**
 * STAGING-ONLY remediation: move the two pre-deploy failed ARV deliveries'
 * reserved units to Return Pending, exactly as reportDeliveryFailure does for
 * a failure today. PREPARED, NOT RUN. Dry run by default.
 *
 * Why: under the old design a failed delivery kept its reservation, so batch
 * BT_2026-013 (jJY8dQhjywBJQAF5CB4B) shows 2 reserved for two orders that will
 * not be delivered. After this, those 2 units are return-pending (neither
 * reserved nor available) until an Admin confirms their condition on
 * Admin › Stock Allocation.
 *
 * Run ONLY after the new Functions, Firestore Rules and web are live on
 * staging — the old code computes available as quantity − reserved and would
 * treat return-pending units as available.
 *
 *   # dry run (reads only)
 *   node scripts/remediateStagingArvReturns.mjs --project vaxtrack-staging
 *   # apply (one transaction per order; re-checks every precondition)
 *   node scripts/remediateStagingArvReturns.mjs --project vaxtrack-staging --apply \
 *     --confirm VT-ORD-1791195696119-0YTC,VT-ORD-1791195833333-YVU3
 *
 * Credentials: Application Default Credentials for an account with Firestore
 * access on vaxtrack-staging (`gcloud auth application-default login`).
 *
 * Guards: refuses any project but vaxtrack-staging (an emulator run is allowed
 * for testing); touches only the two named orders; each must still be
 * delivery_failed with an ACTIVE version-1 reservation of exactly 1 unit on
 * jJY8dQhjywBJQAF5CB4B, or it is skipped with the reason. Deletes nothing;
 * guesses nothing; idempotent (a second run finds nothing reserved).
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const admin = require("firebase-admin");
const { settleFailureReturn } = require("../src/failureReturn.js");

export const TARGETS = Object.freeze([
  { orderId: "0yTCTeFwyBtB1k7udGv3", orderNumber: "VT-ORD-1791195696119-0YTC" },
  { orderId: "yVU3ajkbcWx46HwPN6mV", orderNumber: "VT-ORD-1791195833333-YVU3" },
]);
export const BATCH_ID = "jJY8dQhjywBJQAF5CB4B";
export const PRODUCT_ID = "whqym4POkccJhpA6sMFH";

/** Why [target] must not be touched, or null when it is exactly as expected. */
export function preconditionFailure(target, order, reservation) {
  if (!order) return "order not found";
  if (order.orderNumber !== target.orderNumber) return `order number is ${order.orderNumber}`;
  if (order.status !== "delivery_failed") return `status is ${order.status}`;
  if (order.allocationVersion !== 1) return `allocationVersion is ${order.allocationVersion}`;
  if (!reservation) return "reservation not found";
  if (reservation.status !== "reserved") return `reservation is already ${reservation.status}`;
  const items = Array.isArray(reservation.items) ? reservation.items : [];
  if (items.length !== 1 || items[0].inventoryId !== BATCH_ID || items[0].quantity !== 1) {
    return `reservation items are ${JSON.stringify(items)}`;
  }
  return null;
}

/** One order, one transaction. Returns what happened (or would happen). */
export async function remediateOne({ db, FieldValue, target, apply }) {
  const orderRef = db.collection("orders").doc(target.orderId);
  const reservationRef = db.collection("inventoryReservations").doc(target.orderId);
  return db.runTransaction(async (tx) => {
    const orderSnap = await tx.get(orderRef);
    const resSnap = await tx.get(reservationRef);
    const order = orderSnap.exists ? orderSnap.data() : null;
    const reservation = resSnap.exists ? resSnap.data() : null;
    const why = preconditionFailure(target, order, reservation);
    if (why) return { ...target, action: "skip", why };
    const batchSnap = await tx.get(db.collection("inventory").doc(BATCH_ID));
    const batch = batchSnap.data();
    if (!batch || batch.vaccineId !== PRODUCT_ID || !Number.isInteger(batch.reservedQuantity) || batch.reservedQuantity < 1) {
      return { ...target, action: "skip", why: "batch counters do not match the expected state" };
    }
    if (!apply) {
      return { ...target, action: "would-convert", reservedBefore: batch.reservedQuantity, returnPendingBefore: batch.returnPendingQuantity ?? 0 };
    }
    const settled = await settleFailureReturn(tx, {
      db,
      FieldValue,
      orderId: target.orderId,
      order,
      reservationRef,
      reservation,
      reason: order.deliveryFailureReason ?? null,
      reportedByUid: order.deliveryFailedByUid ?? null,
      // Named in the Stock Allocation History event this settlement writes.
      sourceOperation: "remediateStagingArvReturns",
    });
    tx.update(orderRef, {
      ...settled.orderFields,
      returnMigratedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { ...target, action: "converted", returnId: settled.returnId };
  });
}

async function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const project = arg("--project");
  const apply = argv.includes("--apply");
  const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
  if (project !== "vaxtrack-staging" && !emulator) {
    throw new Error("Refusing: this remediation is for --project vaxtrack-staging only.");
  }
  if (apply) {
    const confirm = (arg("--confirm") ?? "").split(",").filter(Boolean).sort();
    const expected = TARGETS.map((t) => t.orderNumber).sort();
    if (JSON.stringify(confirm) !== JSON.stringify(expected)) {
      throw new Error(`Refusing: --apply requires --confirm ${expected.join(",")}`);
    }
  }
  const app = admin.initializeApp({ projectId: project ?? "demo-vaxtrack-remediation" }, "arv-remediation");
  const db = app.firestore();
  try {
    for (const target of TARGETS) {
      const r = await remediateOne({ db, FieldValue: admin.firestore.FieldValue, target, apply });
      console.log(JSON.stringify(r));
    }
    console.log(apply ? "Applied." : "Dry run only — nothing was written.");
  } finally {
    await app.delete();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
