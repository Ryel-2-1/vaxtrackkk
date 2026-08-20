// VaxTrack Firestore rules — local emulator tests (Step 5, 2026-07-24).
//
// Run via:  npm run test:rules
// which is: firebase emulators:exec --only firestore "node tests/firestore.rules.test.js"
//
// No test framework — a self-contained node script with assertSucceeds/assertFails
// from @firebase/rules-unit-testing. Exits non-zero if any case fails.
//
// NOT a deploy. Storage rules are NOT tested here (Storage is not provisioned).

import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  getDocs,
  query,
  where,
  serverTimestamp,
} from "firebase/firestore";

const PROJECT_ID = "vaxtrack-rules-test";

// Isolated emulator port (default 8181 to avoid a busy 8080; overridable via
// FIRESTORE_EMULATOR_PORT). Must match firebase.json's emulators.firestore.port.
const EMULATOR_PORT = Number(process.env.FIRESTORE_EMULATOR_PORT || 8181);

const adminUid = "admin1";
const dispatcherUid = "disp1";
const salesRepUid = "sr1";
const otherSalesRepUid = "sr2";
const riderUid = "rider1";
const otherRiderUid = "rider2";
const pendingRiderUid = "pending1";
const disabledUid = "disabled1";
const freshRiderUid = "freshRider1"; // used for the registration test

let passed = 0;
let failed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    failures.push(`${name} -> ${e.message}`);
    console.log(`  FAIL  ${name}`);
  }
}

async function main() {
  const testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync("firestore.rules", "utf8"),
      host: "127.0.0.1",
      port: EMULATOR_PORT,
    },
  });

  // ---- seed with rules disabled ----
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "users", adminUid), { role: "admin", status: "approved", email: "a@x.com" });
    await setDoc(doc(db, "users", dispatcherUid), { role: "dispatcher", status: "approved", email: "d@x.com" });
    await setDoc(doc(db, "users", salesRepUid), { role: "salesrep", status: "approved", email: "s@x.com" });
    await setDoc(doc(db, "users", otherSalesRepUid), { role: "salesrep", status: "approved", email: "s2@x.com" });
    await setDoc(doc(db, "users", riderUid), { role: "rider", status: "approved", email: "r@x.com" });
    await setDoc(doc(db, "users", otherRiderUid), { role: "rider", status: "approved", email: "r2@x.com" });
    await setDoc(doc(db, "users", pendingRiderUid), { role: "rider", status: "pending", email: "p@x.com" });
    await setDoc(doc(db, "users", disabledUid), { role: "dispatcher", status: "disabled", email: "x@x.com" });

    await setDoc(doc(db, "orders", "ordSR1"), { createdByUid: salesRepUid, status: "pending_dispatch", assignedRiderId: null });
    await setDoc(doc(db, "orders", "ordSR2"), { createdByUid: otherSalesRepUid, status: "pending_dispatch", assignedRiderId: null });
    await setDoc(doc(db, "orders", "ordRider1"), { createdByUid: salesRepUid, status: "in_transit", assignedRiderId: riderUid });
    await setDoc(doc(db, "orders", "ordRider2"), { createdByUid: salesRepUid, status: "in_transit", assignedRiderId: otherRiderUid });

    await setDoc(doc(db, "inventory", "inv1"), { vaccineName: "X", quantity: 10 });
    await setDoc(doc(db, "clinics", "cl1"), { name: "Clinic A" });
    await setDoc(doc(db, "alerts", "al1"), { status: "active", title: "T" });
    await setDoc(doc(db, "invoices", "invc1"), { orderId: "ordSR1" });
    await setDoc(doc(db, "counters", "invoice_2026"), { value: 1 });

    // Phase 4B fixtures. A rider1-owned route-deviation incident used by the
    // negative UPDATE tests (kept ACTIVE; failing writes never mutate it), and a
    // rider2-owned incident that rider1 must never read or touch.
    await setDoc(doc(db, "alerts", "seedRiderAlert"), {
      type: "route_deviation",
      orderId: "ordRider1",
      riderId: riderUid,
      status: "active",
      severity: "critical",
      read: false,
      createdAt: "seedCreated",
      firstCreatedAt: "seedFirstCreated",
      episodeCount: 1,
    });
    await setDoc(doc(db, "alerts", "seedOtherRiderAlert"), {
      type: "route_deviation",
      orderId: "ordRider2",
      riderId: otherRiderUid,
      status: "active",
      severity: "critical",
      read: false,
      createdAt: "seedCreated2",
      firstCreatedAt: "seedFirstCreated2",
      episodeCount: 1,
    });

    // ---- Phase 5E invoice / counter fixtures ----
    // A legacy ISSUED invoice (old taxRate shape): admin must still read it, and
    // it must be frozen (no financial mutation, no delete).
    await setDoc(doc(db, "invoices", "invLegacy"), {
      orderId: "ordLegacy",
      invoiceStatus: "issued",
      invoiceNumber: "INV-2025-000001",
      createdByUid: adminUid,
      createdAt: "seedLegacyCreated",
      subtotal: 1000,
      grandTotal: 1000,
      taxRate: 12,
      taxAmount: 107.14,
      items: [{ quantity: 1, unitPrice: 1000 }],
    });
    // DRAFT invoices for the positive update + issue transitions (doc id ==
    // orderId). Separate docs so the two tests never couple.
    const draftSeed = (orderId, invoiceNumber) => ({
      orderId,
      invoiceStatus: "draft",
      invoiceNumber,
      createdByUid: adminUid,
      createdByEmail: "a@x.com",
      createdAt: "seedDraftCreated",
      updatedAt: "seedDraftUpdated",
      subtotal: 800,
      net: 800,
      vatAmount: 96,
      vatClassification: "vatable",
      grandTotal: 896,
      items: [{ itemDescription: "X", quantity: 8, unitPrice: 100 }],
    });
    await setDoc(doc(db, "invoices", "ordDraftU"), draftSeed("ordDraftU", "INV-2026-000005"));
    await setDoc(doc(db, "invoices", "ordDraftI"), draftSeed("ordDraftI", "INV-2026-000006"));
    // A counter with a value, for the monotonic-update + decrement-denial tests.
    await setDoc(doc(db, "counters", "invoice_2050"), { current: 5, updatedAt: "seed" });
  });

  const admin = testEnv.authenticatedContext(adminUid).firestore();
  const dispatcher = testEnv.authenticatedContext(dispatcherUid).firestore();
  const salesRep = testEnv.authenticatedContext(salesRepUid).firestore();
  const rider = testEnv.authenticatedContext(riderUid).firestore();
  const pendingRider = testEnv.authenticatedContext(pendingRiderUid).firestore();
  const disabled = testEnv.authenticatedContext(disabledUid).firestore();
  const freshRider = testEnv.authenticatedContext(freshRiderUid).firestore();
  const anon = testEnv.unauthenticatedContext().firestore();

  console.log("\n--- POSITIVE cases ---");

  await check("P1 admin reads + writes a user doc", async () => {
    await assertSucceeds(getDoc(doc(admin, "users", riderUid)));
    await assertSucceeds(setDoc(doc(admin, "users", "tmpUserByAdmin"), { role: "salesrep", status: "pending", email: "t@x.com" }));
  });

  await check("P2 admin reads + writes an order", async () => {
    await assertSucceeds(getDoc(doc(admin, "orders", "ordSR1")));
    await assertSucceeds(setDoc(doc(admin, "orders", "tmpOrderByAdmin"), { createdByUid: salesRepUid, status: "pending_dispatch" }));
  });

  await check("P3 admin writes inventory/clinics/alerts", async () => {
    await assertSucceeds(setDoc(doc(admin, "inventory", "invAdmin"), { vaccineName: "Y" }));
    await assertSucceeds(setDoc(doc(admin, "clinics", "clAdmin"), { name: "C" }));
    await assertSucceeds(setDoc(doc(admin, "alerts", "alAdmin"), { status: "active" }));
  });

  await check("P4 dispatcher queries users where role == 'rider'", async () => {
    await assertSucceeds(getDocs(query(collection(dispatcher, "users"), where("role", "==", "rider"))));
  });

  await check("P5 dispatcher reads an order", async () => {
    await assertSucceeds(getDoc(doc(dispatcher, "orders", "ordSR1")));
  });

  await check("P6 dispatcher updates allowed order fields", async () => {
    await assertSucceeds(updateDoc(doc(dispatcher, "orders", "ordSR1"), {
      status: "assigned",
      assignedRiderId: riderUid,
      assignedRiderName: "R",
      assignedRiderPhone: "0917",
      assignedAt: "t",
      assignedByUid: dispatcherUid,
      assignedByEmail: "d@x.com",
      updatedAt: "t",
    }));
  });

  await check("P7 sales rep creates order with own createdByUid", async () => {
    await assertSucceeds(setDoc(doc(salesRep, "orders", "srNewOrder"), {
      createdByUid: salesRepUid,
      status: "pending_dispatch",
      clinicName: "Clinic A",
    }));
  });

  await check("P8 sales rep reads own order (direct + query)", async () => {
    await assertSucceeds(getDoc(doc(salesRep, "orders", "ordSR1")));
    await assertSucceeds(getDocs(query(collection(salesRep, "orders"), where("createdByUid", "==", salesRepUid))));
  });

  await check("P9 sales rep reads inventory and clinics", async () => {
    await assertSucceeds(getDoc(doc(salesRep, "inventory", "inv1")));
    await assertSucceeds(getDoc(doc(salesRep, "clinics", "cl1")));
  });

  await check("P10 rider reads assigned order (direct + query)", async () => {
    await assertSucceeds(getDoc(doc(rider, "orders", "ordRider1")));
    await assertSucceeds(getDocs(query(collection(rider, "orders"), where("assignedRiderId", "==", riderUid))));
  });

  await check("P11 rider updates allowed status/location/proof fields on assigned order", async () => {
    await assertSucceeds(updateDoc(doc(rider, "orders", "ordRider1"), {
      status: "delivered",
      deliveredAt: "t",
      lastLocation: { lat: 14.5, lng: 121.0 },
      lastLocationUpdate: "t",
      locationAccuracy: 5,
      heading: 0,
      speed: 0,
      proofOfDeliveryUrl: "https://x/p.jpg",
      statusUpdatedAt: "t",
      statusUpdatedByUid: riderUid,
      statusUpdatedByEmail: "r@x.com",
      updatedAt: "t",
    }));
  });

  await check("P12 fresh rider self-registers own user doc (rider + pending)", async () => {
    await assertSucceeds(setDoc(doc(freshRider, "users", freshRiderUid), {
      role: "rider",
      status: "pending",
      fullName: "New Rider",
      email: "new@x.com",
      phone: "0917",
      vehiclePlate: "AAA-111",
    }));
  });

  await check("P13 dispatcher writes route + ETA fields (OpenRouteService)", async () => {
    await assertSucceeds(updateDoc(doc(dispatcher, "orders", "ordRider1"), {
      routePolyline: "abcde_encoded_polyline",
      routeDistanceMeters: 4200,
      routeDurationSeconds: 1380,
      routeEtaText: "3:45 PM",
      routeGeneratedAt: "t",
      routeProvider: "openrouteservice",
      updatedAt: "t",
    }));
  });

  // ---- Phase 4B: rider route-deviation incident happy path ----
  const riderAlertId = "route_deviation_ordRider1_rider1";

  await check("P14 rider creates own route-deviation incident (assigned order)", async () => {
    await assertSucceeds(setDoc(doc(rider, "alerts", riderAlertId), {
      type: "route_deviation",
      orderId: "ordRider1",
      deliveryId: "ordRider1",
      riderId: riderUid,
      riderName: "R",
      clinicName: "Clinic A",
      status: "active",
      severity: "critical",
      read: false,
      title: "Route Deviation Detected",
      message: "left the assigned route",
      episodeCount: 1,
      distanceMeters: 1124,
      createdAt: serverTimestamp(),
      firstCreatedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      lastDetectedAt: serverTimestamp(),
    }));
  });

  await check("P15 rider reads own route-deviation incident", async () => {
    await assertSucceeds(getDoc(doc(rider, "alerts", riderAlertId)));
  });

  await check("P16 rider refreshes own active incident (latest detection)", async () => {
    await assertSucceeds(updateDoc(doc(rider, "alerts", riderAlertId), {
      message: "still off route",
      distanceMeters: 1300,
      updatedAt: serverTimestamp(),
      lastDetectedAt: serverTimestamp(),
    }));
  });

  await check("P17 rider resolves own incident with returned_to_route", async () => {
    await assertSucceeds(updateDoc(doc(rider, "alerts", riderAlertId), {
      status: "resolved",
      resolutionReason: "returned_to_route",
      resolvedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
  });

  await check("P18 rider reopens own incident (refresh createdAt, episode +1)", async () => {
    await assertSucceeds(updateDoc(doc(rider, "alerts", riderAlertId), {
      status: "active",
      resolutionReason: null,
      episodeCount: 2,
      createdAt: serverTimestamp(), // refreshed to now
      reopenedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      lastDetectedAt: serverTimestamp(),
    }));
  });

  // ---- Phase 5E: invoice persistence + counter positives ----
  await check("Pinv1 admin creates a valid DRAFT invoice (docId==orderId, INV number, server time)", async () => {
    await assertSucceeds(setDoc(doc(admin, "invoices", "ordNew1"), {
      orderId: "ordNew1",
      invoiceStatus: "draft",
      invoiceNumber: "INV-2026-000010",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdByUid: adminUid,
      createdByEmail: "a@x.com",
      subtotal: 800,
      grandTotal: 896,
      items: [{ quantity: 8, unitPrice: 100 }],
    }));
  });

  await check("Pinv2 admin updates a DRAFT invoice (financials change, server-timestamped)", async () => {
    await assertSucceeds(updateDoc(doc(admin, "invoices", "ordDraftU"), {
      subtotal: 1700,
      grandTotal: 1904,
      items: [{ quantity: 20, unitPrice: 85 }],
      updatedAt: serverTimestamp(),
      updatedByUid: adminUid,
      updatedByEmail: "a@x.com",
    }));
  });

  await check("Pinv3 admin issues a DRAFT invoice (draft -> issued, totals frozen)", async () => {
    await assertSucceeds(updateDoc(doc(admin, "invoices", "ordDraftI"), {
      invoiceStatus: "issued",
      issuedAt: serverTimestamp(),
      issuedByUid: adminUid,
      issuedByEmail: "a@x.com",
      updatedAt: serverTimestamp(),
      updatedByUid: adminUid,
      updatedByEmail: "a@x.com",
    }));
  });

  await check("Pinv4 admin reads legacy + seeded invoices", async () => {
    await assertSucceeds(getDoc(doc(admin, "invoices", "invLegacy")));
    await assertSucceeds(getDoc(doc(admin, "invoices", "invc1")));
    await assertSucceeds(getDocs(collection(admin, "invoices")));
  });

  await check("Pcnt1 admin creates a counter (current int, server-timestamped)", async () => {
    await assertSucceeds(setDoc(doc(admin, "counters", "invoice_2099"), {
      current: 1,
      updatedAt: serverTimestamp(),
    }));
  });

  await check("Pcnt2 admin increments a counter monotonically", async () => {
    await assertSucceeds(updateDoc(doc(admin, "counters", "invoice_2050"), {
      current: 6,
      updatedAt: serverTimestamp(),
    }));
  });

  console.log("\n--- NEGATIVE cases ---");

  await check("N1 unauthenticated cannot read users", async () => {
    await assertFails(getDoc(doc(anon, "users", adminUid)));
  });

  await check("N2 sales rep cannot read another sales rep's order", async () => {
    await assertFails(getDoc(doc(salesRep, "orders", "ordSR2")));
  });

  await check("N3 sales rep cannot read invoices/counters", async () => {
    await assertFails(getDoc(doc(salesRep, "invoices", "invc1")));
    await assertFails(getDoc(doc(salesRep, "counters", "invoice_2026")));
  });

  await check("N4 dispatcher cannot read invoices/counters", async () => {
    await assertFails(getDoc(doc(dispatcher, "invoices", "invc1")));
    await assertFails(getDoc(doc(dispatcher, "counters", "invoice_2026")));
  });

  await check("N5 rider cannot read an unassigned order", async () => {
    await assertFails(getDoc(doc(rider, "orders", "ordRider2")));
  });

  await check("N6 rider cannot change assignedRiderId on own order", async () => {
    await assertFails(updateDoc(doc(rider, "orders", "ordRider1"), { assignedRiderId: otherRiderUid }));
  });

  await check("N7 pending rider cannot self-approve (change own status/role)", async () => {
    await assertFails(updateDoc(doc(pendingRider, "users", pendingRiderUid), { status: "approved" }));
    await assertFails(updateDoc(doc(rider, "users", riderUid), { role: "admin" }));
  });

  await check("N8 disabled user cannot read protected data", async () => {
    await assertFails(getDoc(doc(disabled, "orders", "ordSR1")));
    await assertFails(getDoc(doc(disabled, "inventory", "inv1")));
  });

  await check("N9 dispatcher cannot read users via unrestricted query / non-rider doc", async () => {
    await assertFails(getDocs(collection(dispatcher, "users")));
    await assertFails(getDocs(query(collection(dispatcher, "users"), where("role", "==", "admin"))));
    await assertFails(getDoc(doc(dispatcher, "users", adminUid)));
  });

  await check("N10 sales rep cannot create an order for another createdByUid", async () => {
    await assertFails(setDoc(doc(salesRep, "orders", "srBadOrder"), { createdByUid: otherSalesRepUid, status: "pending_dispatch" }));
  });

  await check("N11 rider cannot write route fields on own order (dispatcher-only)", async () => {
    await assertFails(updateDoc(doc(rider, "orders", "ordRider1"), {
      routePolyline: "x",
      routeProvider: "openrouteservice",
      updatedAt: "t",
    }));
  });

  // ---- Phase 4B: malicious route-deviation alert operations ----

  await check("N12 rider cannot create an incident for an UNASSIGNED order", async () => {
    await assertFails(setDoc(doc(rider, "alerts", "route_deviation_ordRider2_rider1"), {
      type: "route_deviation",
      orderId: "ordRider2", // assigned to rider2, not rider1
      riderId: riderUid,
      status: "active",
      severity: "critical",
      read: false,
      createdAt: serverTimestamp(),
      firstCreatedAt: serverTimestamp(),
    }));
  });

  await check("N13 rider cannot create an incident spoofing another rider", async () => {
    await assertFails(setDoc(doc(rider, "alerts", "route_deviation_ordRider1_rider2"), {
      type: "route_deviation",
      orderId: "ordRider1",
      riderId: otherRiderUid, // not the caller
      status: "active",
      severity: "critical",
      read: false,
      createdAt: serverTimestamp(),
      firstCreatedAt: serverTimestamp(),
    }));
  });

  await check("N14 rider cannot create a NON-route-deviation alert", async () => {
    await assertFails(setDoc(doc(rider, "alerts", "temp_alert_rider1"), {
      type: "temperature_warning",
      orderId: "ordRider1",
      riderId: riderUid,
      status: "active",
      severity: "critical",
      read: false,
      createdAt: serverTimestamp(),
      firstCreatedAt: serverTimestamp(),
    }));
  });

  await check("N15 rider cannot create with a non-critical severity", async () => {
    await assertFails(setDoc(doc(rider, "alerts", "sev_alert_rider1"), {
      type: "route_deviation",
      orderId: "ordRider1",
      riderId: riderUid,
      status: "active",
      severity: "warning",
      read: false,
      createdAt: serverTimestamp(),
      firstCreatedAt: serverTimestamp(),
    }));
  });

  await check("N16 rider cannot create an incident that is not active", async () => {
    await assertFails(setDoc(doc(rider, "alerts", "status_alert_rider1"), {
      type: "route_deviation",
      orderId: "ordRider1",
      riderId: riderUid,
      status: "resolved",
      severity: "critical",
      read: false,
      createdAt: serverTimestamp(),
      firstCreatedAt: serverTimestamp(),
    }));
  });

  await check("N17 rider cannot back-date createdAt on create", async () => {
    await assertFails(setDoc(doc(rider, "alerts", "backdate_alert_rider1"), {
      type: "route_deviation",
      orderId: "ordRider1",
      riderId: riderUid,
      status: "active",
      severity: "critical",
      read: false,
      createdAt: "2000-01-01T00:00:00Z", // not the server write time
      firstCreatedAt: serverTimestamp(),
    }));
  });

  await check("N18 rider cannot create an incident already marked read", async () => {
    await assertFails(setDoc(doc(rider, "alerts", "read_alert_rider1"), {
      type: "route_deviation",
      orderId: "ordRider1",
      riderId: riderUid,
      status: "active",
      severity: "critical",
      read: true, // must be false on create
      createdAt: serverTimestamp(),
      firstCreatedAt: serverTimestamp(),
    }));
  });

  await check("N19 rider cannot change identity fields on update", async () => {
    await assertFails(updateDoc(doc(rider, "alerts", "seedRiderAlert"), { riderId: otherRiderUid }));
    await assertFails(updateDoc(doc(rider, "alerts", "seedRiderAlert"), { orderId: "ordRider2" }));
    await assertFails(updateDoc(doc(rider, "alerts", "seedRiderAlert"), { type: "temperature_warning" }));
  });

  await check("N20 rider cannot change firstCreatedAt on update", async () => {
    await assertFails(updateDoc(doc(rider, "alerts", "seedRiderAlert"), { firstCreatedAt: "hacked" }));
  });

  await check("N21 rider cannot set an arbitrary status", async () => {
    await assertFails(updateDoc(doc(rider, "alerts", "seedRiderAlert"), { status: "escalated" }));
  });

  await check("N22 rider cannot resolve WITHOUT the returned_to_route reason", async () => {
    await assertFails(updateDoc(doc(rider, "alerts", "seedRiderAlert"), {
      status: "resolved",
      resolutionReason: "made_up_reason",
      resolvedAt: serverTimestamp(),
    }));
  });

  await check("N23 rider cannot back-date createdAt on update", async () => {
    await assertFails(updateDoc(doc(rider, "alerts", "seedRiderAlert"), { createdAt: "2000-01-01T00:00:00Z" }));
  });

  await check("N24 rider cannot downgrade severity on update", async () => {
    await assertFails(updateDoc(doc(rider, "alerts", "seedRiderAlert"), { severity: "warning" }));
  });

  await check("N25 rider cannot list alerts (even filtered to own)", async () => {
    await assertFails(getDocs(collection(rider, "alerts")));
    await assertFails(getDocs(query(collection(rider, "alerts"), where("riderId", "==", riderUid))));
  });

  await check("N26 rider cannot read or modify ANOTHER rider's alert", async () => {
    await assertFails(getDoc(doc(rider, "alerts", "seedOtherRiderAlert")));
    await assertFails(updateDoc(doc(rider, "alerts", "seedOtherRiderAlert"), {
      status: "resolved",
      resolutionReason: "returned_to_route",
    }));
  });

  await check("N27 rider cannot delete an alert", async () => {
    await assertFails(deleteDoc(doc(rider, "alerts", "seedRiderAlert")));
  });

  // ---- Phase 5E: invoice / counter denials ----
  await check("Ninv-A every non-admin role is denied invoice read/list/create/update/delete", async () => {
    for (const ctx of [salesRep, dispatcher, rider]) {
      await assertFails(getDoc(doc(ctx, "invoices", "invc1")));
      await assertFails(getDocs(collection(ctx, "invoices")));
      await assertFails(setDoc(doc(ctx, "invoices", "ordNew1"), {
        orderId: "ordNew1",
        invoiceStatus: "draft",
        invoiceNumber: "INV-2026-000010",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        createdByUid: adminUid,
        subtotal: 0,
        grandTotal: 0,
        items: [],
      }));
      await assertFails(updateDoc(doc(ctx, "invoices", "ordDraftU"), {
        subtotal: 1,
        updatedAt: serverTimestamp(),
      }));
      await assertFails(deleteDoc(doc(ctx, "invoices", "invLegacy")));
    }
  });

  await check("Ncnt-A every non-admin role is denied counter read/write", async () => {
    for (const ctx of [salesRep, dispatcher, rider]) {
      await assertFails(getDoc(doc(ctx, "counters", "invoice_2050")));
      await assertFails(setDoc(doc(ctx, "counters", "invoice_2098"), {
        current: 1,
        updatedAt: serverTimestamp(),
      }));
      await assertFails(updateDoc(doc(ctx, "counters", "invoice_2050"), {
        current: 99,
        updatedAt: serverTimestamp(),
      }));
    }
  });

  await check("Ninv-num admin cannot create with an arbitrary invoice number", async () => {
    await assertFails(setDoc(doc(admin, "invoices", "ordBadNo"), {
      orderId: "ordBadNo",
      invoiceStatus: "draft",
      invoiceNumber: "HACKED-0001",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdByUid: adminUid,
      subtotal: 0,
      grandTotal: 0,
      items: [],
    }));
  });

  await check("Ninv-docid admin cannot create when docId != orderId", async () => {
    await assertFails(setDoc(doc(admin, "invoices", "ordMismatch"), {
      orderId: "SOMETHING_ELSE",
      invoiceStatus: "draft",
      invoiceNumber: "INV-2026-000011",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdByUid: adminUid,
      subtotal: 0,
      grandTotal: 0,
      items: [],
    }));
  });

  await check("Ninv-spoof admin cannot spoof createdAt / createdByUid on create", async () => {
    await assertFails(setDoc(doc(admin, "invoices", "ordSpoofTime"), {
      orderId: "ordSpoofTime",
      invoiceStatus: "draft",
      invoiceNumber: "INV-2026-000012",
      createdAt: "2000-01-01T00:00:00Z", // not the server write time
      updatedAt: serverTimestamp(),
      createdByUid: adminUid,
      subtotal: 0,
      grandTotal: 0,
      items: [],
    }));
    await assertFails(setDoc(doc(admin, "invoices", "ordSpoofUser"), {
      orderId: "ordSpoofUser",
      invoiceStatus: "draft",
      invoiceNumber: "INV-2026-000013",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdByUid: dispatcherUid, // not the calling admin
      subtotal: 0,
      grandTotal: 0,
      items: [],
    }));
  });

  await check("Ninv-status admin cannot create an already-issued invoice", async () => {
    await assertFails(setDoc(doc(admin, "invoices", "ordPreIssued"), {
      orderId: "ordPreIssued",
      invoiceStatus: "issued",
      invoiceNumber: "INV-2026-000014",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdByUid: adminUid,
      subtotal: 0,
      grandTotal: 0,
      items: [],
    }));
  });

  await check("Ninv-identity admin cannot mutate orderId / invoiceNumber on update", async () => {
    await assertFails(updateDoc(doc(admin, "invoices", "ordDraftU"), {
      orderId: "OTHER",
      updatedAt: serverTimestamp(),
      updatedByUid: adminUid,
    }));
    await assertFails(updateDoc(doc(admin, "invoices", "ordDraftU"), {
      invoiceNumber: "INV-2099-999999",
      updatedAt: serverTimestamp(),
      updatedByUid: adminUid,
    }));
  });

  await check("Ninv-frozen admin cannot mutate an ISSUED invoice (financials/identity frozen)", async () => {
    await assertFails(updateDoc(doc(admin, "invoices", "invLegacy"), {
      grandTotal: 5000,
      updatedAt: serverTimestamp(),
      updatedByUid: adminUid,
    }));
    await assertFails(updateDoc(doc(admin, "invoices", "invLegacy"), {
      customerName: "tamper",
      updatedAt: serverTimestamp(),
      updatedByUid: adminUid,
    }));
  });

  await check("Ninv-updspoof admin cannot spoof updatedByUid / updatedAt on update", async () => {
    await assertFails(updateDoc(doc(admin, "invoices", "ordDraftU"), {
      subtotal: 5,
      updatedAt: serverTimestamp(),
      updatedByUid: dispatcherUid,
    }));
    await assertFails(updateDoc(doc(admin, "invoices", "ordDraftU"), {
      subtotal: 5,
      updatedAt: "2000-01-01T00:00:00Z",
      updatedByUid: adminUid,
    }));
  });

  await check("Ninv-issuetamper admin cannot change totals while issuing (draft -> issued)", async () => {
    await assertFails(updateDoc(doc(admin, "invoices", "ordDraftU"), {
      invoiceStatus: "issued",
      grandTotal: 999999, // re-pricing during the issue transition is denied
      issuedAt: serverTimestamp(),
      issuedByUid: adminUid,
      updatedAt: serverTimestamp(),
      updatedByUid: adminUid,
    }));
  });

  await check("Ninv-del admin cannot delete an invoice", async () => {
    await assertFails(deleteDoc(doc(admin, "invoices", "invLegacy")));
    await assertFails(deleteDoc(doc(admin, "invoices", "ordDraftU")));
  });

  await check("Ncnt-mono admin cannot decrement/reset/blank a counter", async () => {
    await assertFails(updateDoc(doc(admin, "counters", "invoice_2050"), {
      current: 2, // < current (6) — non-monotonic
      updatedAt: serverTimestamp(),
    }));
    await assertFails(setDoc(doc(admin, "counters", "invoice_2097"), {
      current: -1, // negative
      updatedAt: serverTimestamp(),
    }));
    await assertFails(setDoc(doc(admin, "counters", "invoice_2096"), {
      current: 1, // missing server timestamp
    }));
  });

  await testEnv.cleanup();

  console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
  if (failed > 0) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log("  - " + f));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("Test harness error:", e);
  process.exit(1);
});
