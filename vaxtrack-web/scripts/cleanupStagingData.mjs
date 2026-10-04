// VaxTrack STAGING data cleanup — DRY RUN ONLY in this version.
//
//   node scripts/cleanupStagingData.mjs --project vaxtrack-staging --dry-run --audit <audit.json>
//
// What the dry run does (reads only):
//  1. refuses unless `--project vaxtrack-staging` is passed AND .env.staging
//     resolves to vaxtrack-staging, and `--dry-run` is present;
//  2. builds the exact plan from the audit report (stagingCleanupPlan.mjs) —
//     exact document ids only, never a collection-wide delete;
//  3. signs in as an approved staging admin and RE-READS the live documents,
//     including each target order's subcollections, and refuses if anything
//     drifted since the audit or if the release would strand or underflow stock;
//  4. prints the final counts and every operation it WOULD run, and writes the
//     plan + a full backup of the readable documents outside the repository.
//
// `--execute` is deliberately refused: the plan still has blockers that a
// client session cannot clear (see BLOCKERS below). Nothing here writes.

import { loadEnv } from "vite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initializeApp, deleteApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { initializeFirestore, collection, doc, getDoc, getDocs } from "firebase/firestore";
import { assertStagingTarget, REQUIRED_PROJECT_ID } from "./stagingAuditAnalysis.mjs";
import { buildCleanupPlan, CANCEL_REASON, releaseByBatch, verifyPlanAgainstLive } from "./stagingCleanupPlan.mjs";

const BLOCKERS = [
  "orderRequestKeys: one per server-created order, keyed uid__requestId — not derivable from the order and deny-all to clients. Locating them needs a privileged (Admin SDK) read.",
  "Rollback needs a privileged write path (Admin SDK / ADC). Client rules forbid re-creating orders, reservations and request keys with their original fields.",
  "inventoryReservations are unreadable to clients; their state is inferred from orders + batches (which reconcile exactly) but not read directly.",
];

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
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

async function readAll(db, name) {
  const snap = await getDocs(collection(db, name));
  return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
}

const SUBCOLLECTIONS = ["destinationChangeRequests", "destinationCorrections"];

async function main() {
  const cfg = loadFirebaseConfig();
  const guard = assertStagingTarget({ argv: process.argv, configuredProjectId: cfg.projectId });
  if (!guard.ok) fail(`Refusing to run: ${guard.message}`);
  if (process.argv.includes("--execute")) {
    fail(`--execute is disabled. BLOCKED:\n  - ${BLOCKERS.join("\n  - ")}`);
  }
  if (!process.argv.includes("--dry-run")) fail("Pass --dry-run explicitly. This version only plans.");

  const auditPath = argValue("--audit");
  if (!auditPath) fail("Pass --audit <path to the audit JSON>.");
  const report = JSON.parse(readFileSync(auditPath, "utf8"));
  if (report?.meta?.project !== REQUIRED_PROJECT_ID) fail(`Audit report is for "${report?.meta?.project}", not ${REQUIRED_PROJECT_ID}.`);

  const plan = buildCleanupPlan(report);

  const email = process.env.VAXTRACK_AUDIT_EMAIL || process.env.VAXTRACK_SEED_EMAIL;
  const password = process.env.VAXTRACK_AUDIT_PASSWORD || process.env.VAXTRACK_SEED_PASSWORD;
  if (!email || !password) fail("Set VAXTRACK_AUDIT_EMAIL and VAXTRACK_AUDIT_PASSWORD (approved staging admin).");

  const app = initializeApp(cfg);
  const auth = getAuth(app);
  const db = initializeFirestore(app, { experimentalForceLongPolling: true });
  const outDir = argValue("--out-dir") || join(tmpdir(), "vaxtrack-staging-cleanup");

  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    const me = await getDoc(doc(db, "users", cred.user.uid));
    if (!me.exists() || me.data().role !== "admin" || me.data().status !== "approved") {
      throw new Error("Signed-in account is not an approved admin.");
    }

    const [orders, inventory, alerts, invoices] = await Promise.all([
      readAll(db, "orders"),
      readAll(db, "inventory"),
      readAll(db, "alerts"),
      readAll(db, "invoices"),
    ]);

    const removing = [...plan.cancelFirst, ...plan.deleteOnly].map((e) => e.id);
    const subcollections = {};
    for (const id of removing) {
      const docs = [];
      for (const name of SUBCOLLECTIONS) {
        const snap = await getDocs(collection(db, "orders", id, name));
        snap.docs.forEach((d) => docs.push({ path: `orders/${id}/${name}/${d.id}`, data: d.data() }));
      }
      subcollections[id] = docs;
    }

    // Full-fidelity backup of every READABLE document the plan touches. Kept
    // outside the repo; it contains raw fields and must not be shared.
    const byId = new Map(orders.map((o) => [o.id, o]));
    const touchedBatches = new Set(Object.keys(releaseByBatch(plan)));
    const backup = {
      project: cfg.projectId,
      takenAt: new Date().toISOString(),
      orders: removing.map((id) => ({ path: `orders/${id}`, data: byId.get(id) ?? null })),
      orderSubcollections: Object.values(subcollections).flat(),
      alerts: alerts.filter((a) => plan.deletePaths.alerts.includes(`alerts/${a.id}`)).map((a) => ({ path: `alerts/${a.id}`, data: a })),
      inventoryBefore: inventory.filter((b) => touchedBatches.has(b.id)).map((b) => ({ path: `inventory/${b.id}`, data: b })),
      notBackedUp: ["inventoryReservations/* (deny-all to clients)", "orderRequestKeys/* (deny-all to clients)"],
    };

    const problems = verifyPlanAgainstLive(plan, {
      orders,
      inventory,
      alerts,
      invoices,
      subcollections,
      backedUpSubcollections: true,
    });

    const stamp = Date.now();
    mkdirSync(outDir, { recursive: true });
    const planPath = join(outDir, `plan-${stamp}.json`);
    const backupPath = join(outDir, `backup-preview-${stamp}.json`);
    writeFileSync(planPath, JSON.stringify({ plan, release: releaseByBatch(plan), problems, blockers: BLOCKERS }, null, 2));
    mkdirSync(dirname(backupPath), { recursive: true });
    writeFileSync(backupPath, JSON.stringify(backup, null, 2));

    const subCount = Object.values(subcollections).reduce((s, l) => s + l.length, 0);
    console.log(`\nVaxTrack staging cleanup — DRY RUN (nothing written)`);
    console.log(`Project: ${cfg.projectId}`);
    console.log(`\nPhase 1  cancel via cancelOrderWithInventoryRelease (dispatcher), reason "${CANCEL_REASON}": ${plan.cancelFirst.length}`);
    plan.cancelFirst.forEach((e) => console.log(`  cancel  ${e.id}  ${e.orderNumber}  (${e.status})`));
    console.log(`\nPhase 2  delete exact paths (firebase firestore:delete <path> -r --project ${REQUIRED_PROJECT_ID}):`);
    [...plan.deletePaths.orders, ...plan.deletePaths.inventoryReservations, ...plan.deletePaths.alerts].forEach((p) =>
      console.log(`  delete  ${p}`)
    );
    console.log(`\nCounts: cancel ${plan.cancelFirst.length}, delete orders ${plan.deletePaths.orders.length} ` +
      `(+${subCount} subcollection docs), reservations ${plan.deletePaths.inventoryReservations.length}, ` +
      `alerts ${plan.deletePaths.alerts.length}, invoices 0, keep ${plan.keep.length}`);
    console.log(`Request keys still to locate (privileged read): ${plan.deletePaths.orderRequestKeysToLocate.length}`);
    console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n  - ${problems.join("\n  - ")}` : `\nLive data matches the audit: no drift, no stock underflow.`);
    console.log(`\nBLOCKED for execution:\n  - ${BLOCKERS.join("\n  - ")}`);
    console.log(`\nPlan:   ${planPath}\nBackup: ${backupPath}  (raw data — keep private)\nNo Firebase data was changed.\n`);
  } finally {
    await signOut(auth).catch(() => {});
    await deleteApp(app).catch(() => {});
  }
}

main().catch((err) => {
  console.error(`\n✖ Dry run failed: ${err?.code || ""} ${err?.message || err}\n`);
  process.exit(1);
});
