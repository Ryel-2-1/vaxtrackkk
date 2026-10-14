// Remove the LEGACY rider-location copies from orders and rider users — STAGING ONLY.
//
//   node scripts/cleanupLegacyRiderLocations.mjs --project vaxtrack-staging            # DRY RUN
//   node scripts/cleanupLegacyRiderLocations.mjs --project vaxtrack-staging --apply    # writes, IF confirmed
//
// Safety model:
//  * refuses unless `--project vaxtrack-staging` is passed AND .env.staging
//    resolves to vaxtrack-staging — production is refused outright; a
//    production run is a separate, explicit decision;
//  * dry run is the default and reads only; it prints document ids, field
//    names and counts — NEVER a coordinate;
//  * --apply ALSO requires VAXTRACK_CLEANUP_CONFIRM === "vaxtrack-staging";
//  * signs in as an existing approved staging ADMIN (VAXTRACK_AUDIT_EMAIL /
//    VAXTRACK_AUDIT_PASSWORD, never printed or stored);
//  * deletes ONLY the five legacy fields (scripts/legacyRiderLocationPlan.mjs)
//    with deleteField(); never deletes a document, never touches another field;
//  * re-reads each document inside the batch window and skips any that changed
//    shape (no field to remove any more).
//
// No backup of the removed values is written: they are superseded copies of
// personal location data, and removing them is the point.
//
// Run it only AFTER every rider device runs the build that writes
// riderLocations/{uid} — an older build would write the copies again.

import { loadEnv } from "vite";
import { initializeApp, deleteApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { initializeFirestore, collection, deleteField, doc, getDoc, getDocs, query, where, writeBatch } from "firebase/firestore";
import { assertStagingTarget, REQUIRED_PROJECT_ID } from "./stagingAuditAnalysis.mjs";
import { chunk, legacyFieldsIn, planLegacyLocationCleanup, summarizePlan } from "./legacyRiderLocationPlan.mjs";

const APPLY = process.argv.includes("--apply");

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function loadFirebaseConfig() {
  const env = loadEnv("staging", process.cwd(), "VITE_");
  return {
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: env.VITE_FIREBASE_APP_ID,
  };
}

async function main() {
  const cfg = loadFirebaseConfig();
  const guard = assertStagingTarget({ argv: process.argv, configuredProjectId: cfg.projectId });
  if (!guard.ok) fail(`Refusing to run: ${guard.message}`);
  if (APPLY && process.env.VAXTRACK_CLEANUP_CONFIRM !== REQUIRED_PROJECT_ID) {
    fail(`--apply also needs VAXTRACK_CLEANUP_CONFIRM=${REQUIRED_PROJECT_ID}.`);
  }
  const email = process.env.VAXTRACK_AUDIT_EMAIL || process.env.VAXTRACK_SEED_EMAIL;
  const password = process.env.VAXTRACK_AUDIT_PASSWORD || process.env.VAXTRACK_SEED_PASSWORD;
  if (!email || !password) fail("Set VAXTRACK_AUDIT_EMAIL and VAXTRACK_AUDIT_PASSWORD (approved staging admin).");

  const app = initializeApp(cfg);
  const auth = getAuth(app);
  const db = initializeFirestore(app, { experimentalForceLongPolling: true });
  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    const me = await getDoc(doc(db, "users", cred.user.uid));
    if (!me.exists() || me.data().role !== "admin" || me.data().status !== "approved") {
      throw new Error("Signed-in account is not an approved admin.");
    }

    const [orderSnap, riderSnap] = await Promise.all([
      getDocs(collection(db, "orders")),
      getDocs(query(collection(db, "users"), where("role", "==", "rider"))),
    ]);
    const ops = planLegacyLocationCleanup({
      orders: orderSnap.docs.map((d) => ({ ...d.data(), id: d.id })),
      users: riderSnap.docs.map((d) => ({ ...d.data(), id: d.id })),
    });
    const summary = summarizePlan(ops);

    console.log(`\nProject: ${cfg.projectId}   Mode: ${APPLY ? "APPLY" : "DRY RUN (no writes)"}`);
    console.log(`Documents with legacy location fields: ${summary.documents}`);
    console.log(`  by collection: ${JSON.stringify(summary.byCollection)}`);
    console.log(`  by field:      ${JSON.stringify(summary.byField)}`);
    for (const op of ops) console.log(`  ${op.collection}/${op.id}: delete ${op.fields.join(", ")}`);

    if (!APPLY) {
      console.log("\nDry run only. Re-run with --apply and VAXTRACK_CLEANUP_CONFIRM to remove them.\n");
      return;
    }

    let removed = 0;
    let skipped = 0;
    for (const group of chunk(ops)) {
      const batch = writeBatch(db);
      let writes = 0;
      for (const op of group) {
        // Re-read: remove only what is still there now.
        const snap = await getDoc(doc(db, op.collection, op.id));
        const fields = snap.exists() ? legacyFieldsIn(op.collection, snap.data()) : [];
        if (fields.length === 0) {
          skipped += 1;
          continue;
        }
        batch.update(doc(db, op.collection, op.id), Object.fromEntries(fields.map((f) => [f, deleteField()])));
        writes += 1;
      }
      if (writes) await batch.commit();
      removed += writes;
    }
    console.log(`\nRemoved legacy fields from ${removed} document(s); ${skipped} already clean.\n`);
  } finally {
    await signOut(auth).catch(() => {});
    await deleteApp(app).catch(() => {});
  }
}

main().catch((err) => fail(err?.code ? `Firebase error: ${err.code}` : err?.message || String(err)));
