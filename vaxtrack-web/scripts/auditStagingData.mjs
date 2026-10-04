// READ-ONLY audit of the VaxTrack STAGING data behind the Admin dashboard.
//
//   node scripts/auditStagingData.mjs --project vaxtrack-staging [--out <file.json>]
//
// Safety model:
//  * refuses to run unless BOTH `--project vaxtrack-staging` is passed AND
//    .env.staging resolves to `vaxtrack-staging` (production is never reachable);
//  * imports only Firestore READ functions — there is no write, update, delete,
//    batch or transaction call anywhere in this file (a test enforces that);
//  * signs in as an existing approved staging ADMIN from env vars
//    VAXTRACK_AUDIT_EMAIL / VAXTRACK_AUDIT_PASSWORD (falls back to the seeder's
//    VAXTRACK_SEED_EMAIL / VAXTRACK_SEED_PASSWORD). Never printed or stored;
//  * Firestore security rules stay in force — reservations and idempotency keys
//    are deny-all to clients, so they are reconciled from order + batch fields;
//  * the report omits emails, phone numbers and proof/photo URLs (URLs carry
//    access tokens) — proof is reported as presence + host kind only;
//  * the JSON report is written OUTSIDE the repository (OS temp dir by default).

import { loadEnv } from "vite";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initializeApp, deleteApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { initializeFirestore, collection, doc, getDoc, getDocs } from "firebase/firestore";
import {
  REQUIRED_PROJECT_ID,
  analyzeOrders,
  assertStagingTarget,
  averageLatestTransit,
  deliveriesMetrics,
  inventoryReconciliation,
  invoiceMetrics,
  orphanedRelated,
} from "./stagingAuditAnalysis.mjs";

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

// Only the fields the audit needs; no email, phone or free-text profile data.
function slimUser(u) {
  const role = typeof u.role === "string" ? u.role.trim().toLowerCase() : null;
  const status = typeof u.status === "string" ? u.status.trim().toLowerCase() : null;
  return { uid: u.id, role, status, name: u.fullName || u.name || u.displayName || null };
}

async function main() {
  const cfg = loadFirebaseConfig();
  const guard = assertStagingTarget({ argv: process.argv, configuredProjectId: cfg.projectId });
  if (!guard.ok) fail(`Refusing to run: ${guard.message}`);

  const email = process.env.VAXTRACK_AUDIT_EMAIL || process.env.VAXTRACK_SEED_EMAIL;
  const password = process.env.VAXTRACK_AUDIT_PASSWORD || process.env.VAXTRACK_SEED_PASSWORD;
  if (!email || !password) {
    fail(
      "Set VAXTRACK_AUDIT_EMAIL and VAXTRACK_AUDIT_PASSWORD (an approved staging admin). " +
        "They are never printed or stored."
    );
  }

  const outPath =
    argValue("--out") || join(tmpdir(), "vaxtrack-staging-audit", `audit-${Date.now()}.json`);

  const app = initializeApp(cfg);
  const auth = getAuth(app);
  const db = initializeFirestore(app, { experimentalForceLongPolling: true });

  console.log(`\nVaxTrack staging data audit — READ ONLY`);
  console.log(`Project:   ${cfg.projectId}`);

  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    const me = await getDoc(doc(db, "users", cred.user.uid));
    const role = me.exists() ? me.data().role : null;
    const status = me.exists() ? me.data().status : null;
    if (role !== "admin" || status !== "approved") {
      throw new Error(`Signed-in account is not an approved admin (role=${role}, status=${status}).`);
    }
    console.log(`Signed in: approved admin (${cred.user.uid.slice(0, 6)}…)`);

    const [orders, inventory, invoices, alerts, usersRaw, clinics, doctors, areas] = await Promise.all([
      readAll(db, "orders"),
      readAll(db, "inventory"),
      readAll(db, "invoices"),
      readAll(db, "alerts"),
      readAll(db, "users"),
      readAll(db, "clinics"),
      readAll(db, "doctors"),
      readAll(db, "areas"),
    ]);

    const addresses = new Set();
    const addressRows = [];
    for (const d of doctors) {
      const snap = await getDocs(collection(db, "doctors", d.id, "deliveryAddresses"));
      for (const a of snap.docs) {
        addresses.add(`${d.id}/${a.id}`);
        const data = a.data();
        addressRows.push({
          doctorId: d.id,
          addressId: a.id,
          type: data.destinationType ?? data.type ?? null,
          clinicDocId: data.clinicDocId ?? null,
          active: data.active ?? null,
        });
      }
    }

    const users = new Map(usersRaw.map((u) => [u.id, slimUser(u)]));
    const refs = {
      clinics: new Set(clinics.map((c) => c.id)),
      doctors: new Set(doctors.map((d) => d.id)),
      addresses,
      users,
    };
    const nowMs = Date.now();

    const findings = analyzeOrders(orders, { refs, invoices, alerts, nowMs });
    const verdictCounts = {};
    for (const f of findings) {
      verdictCounts[f.classification.verdict] = (verdictCounts[f.classification.verdict] || 0) + 1;
    }

    const report = {
      meta: {
        project: cfg.projectId,
        generatedAt: new Date(nowMs).toISOString(),
        readOnly: true,
        counts: {
          orders: orders.length,
          inventory: inventory.length,
          invoices: invoices.length,
          alerts: alerts.length,
          users: usersRaw.length,
          clinics: clinics.length,
          doctors: doctors.length,
          deliveryAddresses: addressRows.length,
          areas: areas.length,
        },
        notReadable: [
          "inventoryReservations (deny-all to clients; reconciled from orders.allocationStatus + inventory.reservedQuantity)",
          "orderRequestKeys (deny-all to clients; one per server-created order, keyed uid__requestId)",
          "Firebase Storage objects (only proof URL presence/host kind is reported)",
        ],
      },
      metrics: {
        deliveries: deliveriesMetrics(orders),
        averageLatestTransit30d: averageLatestTransit(orders, { nowMs, days: 30 }),
        averageLatestTransitAllTime: averageLatestTransit(orders, { nowMs, days: null }),
        invoices: invoiceMetrics(orders, invoices),
      },
      verdictCounts,
      orders: findings,
      inventory: inventoryReconciliation(inventory, orders),
      orphans: orphanedRelated({ orders, invoices, alerts }),
      reference: {
        users: [...users.values()],
        clinics: clinics.map((c) => ({
          id: c.id,
          name: c.name ?? c.clinicName ?? null,
          status: c.status ?? null,
          latitude: c.latitude ?? null,
          longitude: c.longitude ?? null,
          areaId: c.areaId ?? null,
        })),
        doctors: doctors.map((d) => ({ id: d.id, name: d.name ?? null, areaId: d.areaId ?? null, active: d.active ?? null })),
        deliveryAddresses: addressRows,
        areas: areas.map((a) => ({ id: a.id, name: a.name ?? null, active: a.active ?? null })),
        alerts: alerts.map((a) => ({ id: a.id, type: a.type ?? null, orderId: a.orderId ?? null, status: a.status ?? null })),
        invoices: invoices.map((i) => ({ id: i.id, orderId: i.orderId ?? null, invoiceStatus: i.invoiceStatus ?? null, invoiceNumber: i.invoiceNumber ?? null })),
      },
    };

    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(report, null, 2));

    const m = report.metrics;
    console.log(`\nOrders read: ${orders.length}`);
    console.log(
      `Deliveries: total ${m.deliveries.totalDeliveries}, in transit ${m.deliveries.inTransit}, ` +
        `delayed ${m.deliveries.delayed}, failed ${m.deliveries.deliveryFailed}, preparing ${m.deliveries.preparing}`
    );
    console.log(`Avg latest transit (30d): ${m.averageLatestTransit30d.formatted}`);
    console.log(`Pending invoices: ${m.invoices.pendingInvoices}, high priority: ${m.invoices.highPriority}`);
    console.log(`Verdicts: ${JSON.stringify(verdictCounts)}`);
    console.log(`\nReport written (outside the repo): ${outPath}`);
    console.log(`No Firebase data was changed.\n`);
  } finally {
    await signOut(auth).catch(() => {});
    await deleteApp(app).catch(() => {});
  }
}

main().catch((err) => {
  // Never echo the credentials; the message is from Firebase or the guard.
  console.error(`\n✖ Audit failed: ${err?.code || ""} ${err?.message || err}\n`);
  process.exit(1);
});
