// VaxTrack Firestore rules — local emulator tests (Step 5, 2026-07-24).
//
// Run via:  npm run test:rules
// which is: firebase emulators:exec --only firestore "node tests/firestore.rules.test.js"
//
// No test framework — a self-contained node script with assertSucceeds/assertFails
// from @firebase/rules-unit-testing. Exits non-zero if any case fails.
//
// NOT a deploy. Storage rules are NOT tested here (Storage is not provisioned).
//
// This file runs under Node, not the browser, so `process` is a legitimate
// global here. The shared ESLint config targets browser source and does not
// declare it — hence this directive rather than a config change.
/* global process */

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
  runTransaction,
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

// A fixed clinic location-save time, so an order's copied
// clinicLocationUpdatedAt can be compared against a known value.
const CLINIC_STAMP = new Date("2026-08-01T00:00:00.000Z");

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
    // A THIRD assigned order with NO alert yet — used to reproduce the real
    // service's transaction upsert, which reads the deterministic alert doc
    // before it exists.
    await setDoc(doc(db, "orders", "ordRider3"), { createdByUid: salesRepUid, status: "in_transit", assignedRiderId: riderUid });

    await setDoc(doc(db, "inventory", "inv1"), { vaccineName: "X", quantity: 10 });
    await setDoc(doc(db, "clinics", "cl1"), { name: "Clinic A" });

    // ---- Phase 02A order-snapshot fixtures ----
    // Dedicated clinics so these cases never depend on cl1, which Pclin1 mutates.
    await setDoc(doc(db, "clinics", "clVerified"), {
      name: "Verified Clinic",
      clinicId: "CLN-9123",
      latitude: 14.5995,
      longitude: 120.9842,
      geofenceRadiusM: 150, // deliberately NOT the 300 default
      locationVerified: true,
    });
    // Verified, but no stored radius — an order must inherit exactly 300.
    await setDoc(doc(db, "clinics", "clDefaultRadius"), {
      name: "Default Radius Clinic",
      clinicId: "CLN-0300",
      latitude: 10.5,
      longitude: 122.5,
      locationVerified: true,
    });
    // Real legacy shape: pinned before Phase 01, so coordinates exist but the
    // verification flag never does. Coordinates alone must not geofence.
    await setDoc(doc(db, "clinics", "clUnverified"), {
      name: "Legacy Pinned Clinic",
      clinicId: "CLN-6961",
      latitude: 14.5995,
      longitude: 120.9842,
    });
    // ---- Phase 02A hardening fixtures ----
    // Verified AND carrying a source timestamp, so an order's copied
    // clinicLocationUpdatedAt can be checked against the real clinic value.
    await setDoc(doc(db, "clinics", "clStamped"), {
      name: "Stamped Clinic",
      clinicId: "CLN-7777",
      latitude: 12.0,
      longitude: 121.0,
      geofenceRadiusM: 200,
      locationVerified: true,
      locationUpdatedAt: CLINIC_STAMP,
    });
    // Verified with NO business id at all — three of five live staging clinics
    // are in this state, so an order must be creatable without one.
    await setDoc(doc(db, "clinics", "clNoBusinessId"), {
      name: "No Business Id Clinic",
      latitude: 13.0,
      longitude: 123.0,
      geofenceRadiusM: 250,
      locationVerified: true,
    });

    // Verified but with an out-of-bounds radius: no order may inherit it.
    await setDoc(doc(db, "clinics", "clBadRadius"), {
      name: "Bad Radius Clinic",
      clinicId: "CLN-5000",
      latitude: 14.6,
      longitude: 120.99,
      geofenceRadiusM: 5000,
      locationVerified: true,
    });
    // An order created BEFORE Phase 02A: no snapshot fields at all. Must stay
    // readable and keep moving through its normal lifecycle.
    await setDoc(doc(db, "orders", "ordLegacyNoSnapshot"), {
      createdByUid: salesRepUid,
      status: "assigned",
      assignedRiderId: riderUid,
      clinicName: "Legacy Clinic",
    });
    // An order that already carries a valid snapshot — used for mutation tests.
    await setDoc(doc(db, "orders", "ordWithSnapshot"), {
      createdByUid: salesRepUid,
      status: "assigned",
      assignedRiderId: riderUid,
      clinicDocId: "clVerified",
      clinicId: "CLN-9123",
      clinicLat: 14.5995,
      clinicLng: 120.9842,
      clinicGeofenceRadiusM: 150,
      clinicLocationVerified: true,
    });

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

  await check("P12 fresh rider self-registers own user doc (rider + pending + motorcycle)", async () => {
    await assertSucceeds(setDoc(doc(freshRider, "users", freshRiderUid), {
      role: "rider",
      status: "pending",
      vehicleType: "Motorcycle",
      fullName: "New Rider",
      email: "new@x.com",
      phone: "0917",
      vehiclePlate: "AAA-111",
    }));
  });

  // ---- Rider self-registration identity boundary ----
  // Riders create their own accounts, so a modified client must not be able to
  // register anything other than a pending motorcycle rider owned by itself.
  const selfRegistration = (extra) => ({
    role: "rider",
    status: "pending",
    vehicleType: "Motorcycle",
    fullName: "Probe Rider",
    email: "probe@x.com",
    phone: "0917",
    vehiclePlate: "BBB-222",
    ...extra,
  });

  await check("Nreg1 self-registration without a vehicle type is rejected", async () => {
    const payload = selfRegistration();
    delete payload.vehicleType;
    await assertFails(setDoc(doc(freshRider, "users", "regNoType"), payload));
  });

  await check("Nreg2 a non-motorcycle vehicle type is rejected", async () => {
    for (const vehicleType of ["Van", "Truck", "Auto", "motorcycle", ""]) {
      await assertFails(
        setDoc(doc(freshRider, "users", "regBadType"), selfRegistration({ vehicleType }))
      );
    }
  });

  await check("Nreg3 a rider cannot self-register as another role", async () => {
    for (const role of ["admin", "dispatcher", "salesrep"]) {
      await assertFails(
        setDoc(doc(freshRider, "users", "regBadRole"), selfRegistration({ role }))
      );
    }
  });

  await check("Nreg4 a rider cannot self-register already approved", async () => {
    for (const status of ["approved", "active", "disabled"]) {
      await assertFails(
        setDoc(doc(freshRider, "users", "regBadStatus"), selfRegistration({ status }))
      );
    }
  });

  await check("Nreg5 a rider cannot create another user's document", async () => {
    // Correct shape, wrong owner: the uid must match the document id.
    await assertFails(
      setDoc(doc(freshRider, "users", "someoneElseUid"), selfRegistration())
    );
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

  // P14b/P14c reproduce the REAL service path (route_deviation_alert_service):
  // the idempotent upsert runs in a TRANSACTION that reads the deterministic doc
  // BEFORE it exists. The rider `get` rule must therefore allow reading a
  // NON-EXISTENT own alert, or the transaction is denied at the read — the
  // Phase 6C2 persistence root cause (direct setDoc in P14 never hit this path).
  await check("P14b rider can get a non-existent own route-deviation alert (tx pre-read)", async () => {
    await assertSucceeds(getDoc(doc(rider, "alerts", "route_deviation_ordRider3_rider1")));
  });

  await check("P14c rider transaction get-then-create on a fresh assigned order", async () => {
    const ref = doc(rider, "alerts", "route_deviation_ordRider3_rider1");
    await assertSucceeds(
      runTransaction(rider, async (tx) => {
        await tx.get(ref); // reads the not-yet-existing doc, exactly like the app
        tx.set(ref, {
          type: "route_deviation",
          orderId: "ordRider3",
          deliveryId: "ordRider3",
          riderId: riderUid,
          riderName: "R",
          clinicName: "Clinic C",
          status: "active",
          severity: "critical",
          read: false,
          title: "Route Deviation Detected",
          message: "left the assigned route",
          episodeCount: 1,
          distanceMeters: 392,
          createdAt: serverTimestamp(),
          firstCreatedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          lastDetectedAt: serverTimestamp(),
        });
      })
    );
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

  // ---- clinic location / geofence (Phase 01) ----
  // The clinics rule ALREADY restricted writes to admin, so Phase 01 changed no
  // rule. These cases lock that in so the new Admin location editor cannot be
  // widened by accident later, and so the reads other roles depend on stay open.

  await check("Pclin1 admin updates clinic location + geofence fields", async () => {
    await assertSucceeds(updateDoc(doc(admin, "clinics", "cl1"), {
      latitude: 14.5995,
      longitude: 120.9842,
      geofenceRadiusM: 300,
      locationVerified: true,
      locationUpdatedAt: serverTimestamp(),
    }));
  });

  await check("Pclin2 dispatcher, sales rep and rider can still READ clinics", async () => {
    await assertSucceeds(getDoc(doc(dispatcher, "clinics", "cl1")));
    await assertSucceeds(getDoc(doc(salesRep, "clinics", "cl1")));
    await assertSucceeds(getDoc(doc(rider, "clinics", "cl1")));
  });

  await check("Nclin1 non-admin roles cannot write clinic master location", async () => {
    for (const db of [dispatcher, salesRep, rider]) {
      await assertFails(updateDoc(doc(db, "clinics", "cl1"), {
        latitude: 0,
        longitude: 0,
        geofenceRadiusM: 1000,
      }));
    }
  });

  await check("Nclin2 non-admin roles cannot create or delete a clinic", async () => {
    for (const db of [dispatcher, salesRep, rider]) {
      await assertFails(setDoc(doc(db, "clinics", "clRogue"), { name: "Rogue" }));
      await assertFails(deleteDoc(doc(db, "clinics", "cl1")));
    }
  });

  await check("Nclin3 unauthenticated cannot read or write clinics", async () => {
    await assertFails(getDoc(doc(anon, "clinics", "cl1")));
    await assertFails(updateDoc(doc(anon, "clinics", "cl1"), { latitude: 1 }));
  });

  // ================= Phase 02A — order clinic-location snapshot =================
  //
  // The client builds the snapshot, so the rules re-derive it from the clinic
  // document. A client may choose WHICH clinic an order goes to; it may never
  // choose where that clinic is, or how large its geofence is.

  const newOrder = (extra) => ({
    createdByUid: salesRepUid,
    status: "pending_dispatch",
    clinicName: "Some Clinic",
    vaccineName: "V",
    quantity: 1,
    ...extra,
  });

  await check("Psnap1 sales rep creates an order with a faithful verified snapshot", async () => {
    await assertSucceeds(setDoc(doc(salesRep, "orders", "snapOk1"), newOrder({
      clinicDocId: "clVerified",
      clinicId: "CLN-9123",
      clinicLat: 14.5995,
      clinicLng: 120.9842,
      clinicGeofenceRadiusM: 150,
      clinicLocationVerified: true,
      clinicLocationSnapshotAt: serverTimestamp(),
    })));
  });

  await check("Psnap2 a clinic with no stored radius yields exactly the 300 m default", async () => {
    await assertSucceeds(setDoc(doc(salesRep, "orders", "snapOk2"), newOrder({
      clinicDocId: "clDefaultRadius",
      clinicId: "CLN-0300",
      clinicLat: 10.5,
      clinicLng: 122.5,
      clinicGeofenceRadiusM: 300,
      clinicLocationVerified: true,
      clinicLocationSnapshotAt: serverTimestamp(),
    })));
  });

  await check("Psnap3 unverified clinic order is accepted WITHOUT geofence data", async () => {
    await assertSucceeds(setDoc(doc(salesRep, "orders", "snapOk3"), newOrder({
      clinicDocId: "clUnverified",
      clinicId: "CLN-6961",
      clinicLocationVerified: false,
      clinicLocationSnapshotAt: serverTimestamp(),
    })));
  });

  await check("Psnap4 an order with no snapshot fields at all is still accepted", async () => {
    // Legacy shape — creation must not become impossible for callers that
    // predate the snapshot.
    await assertSucceeds(setDoc(doc(salesRep, "orders", "snapOk4"), newOrder({})));
  });

  await check("Psnap5 legacy order (no snapshot) keeps its dispatcher lifecycle", async () => {
    await assertSucceeds(updateDoc(doc(dispatcher, "orders", "ordLegacyNoSnapshot"), {
      status: "loading",
      statusUpdatedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
  });

  await check("Psnap6 legacy order keeps its rider lifecycle", async () => {
    await assertSucceeds(updateDoc(doc(rider, "orders", "ordLegacyNoSnapshot"), {
      status: "in_transit",
      startedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
  });

  await check("Nsnap1 forged latitude is rejected", async () => {
    await assertFails(setDoc(doc(salesRep, "orders", "snapBad1"), newOrder({
      clinicDocId: "clVerified",
      clinicLat: 1.234, // not the clinic's
      clinicLng: 120.9842,
      clinicGeofenceRadiusM: 150,
      clinicLocationVerified: true,
    })));
  });

  await check("Nsnap2 forged longitude is rejected", async () => {
    await assertFails(setDoc(doc(salesRep, "orders", "snapBad2"), newOrder({
      clinicDocId: "clVerified",
      clinicLat: 14.5995,
      clinicLng: 5.678, // not the clinic's
      clinicGeofenceRadiusM: 150,
      clinicLocationVerified: true,
    })));
  });

  await check("Nsnap3 forged radius is rejected", async () => {
    await assertFails(setDoc(doc(salesRep, "orders", "snapBad3"), newOrder({
      clinicDocId: "clVerified",
      clinicLat: 14.5995,
      clinicLng: 120.9842,
      clinicGeofenceRadiusM: 1000, // clinic is 150
      clinicLocationVerified: true,
    })));
  });

  await check("Nsnap4 a clinicDocId that does not exist is rejected", async () => {
    await assertFails(setDoc(doc(salesRep, "orders", "snapBad4"), newOrder({
      clinicDocId: "clDoesNotExist",
      clinicLocationVerified: false,
    })));
  });

  await check("Nsnap5 a business clinicId that is not the clinic's own is rejected", async () => {
    await assertFails(setDoc(doc(salesRep, "orders", "snapBad5"), newOrder({
      clinicDocId: "clVerified",
      clinicId: "CLN-0000", // clinic's is CLN-9123
      clinicLat: 14.5995,
      clinicLng: 120.9842,
      clinicGeofenceRadiusM: 150,
      clinicLocationVerified: true,
    })));
  });

  await check("Nsnap6 claiming verified for an unverified clinic is rejected", async () => {
    // The clinic has real coordinates but no locationVerified flag. Copying them
    // and asserting verification must not be possible.
    await assertFails(setDoc(doc(salesRep, "orders", "snapBad6"), newOrder({
      clinicDocId: "clUnverified",
      clinicLat: 14.5995,
      clinicLng: 120.9842,
      clinicGeofenceRadiusM: 300,
      clinicLocationVerified: true,
    })));
  });

  await check("Nsnap7 an UNVERIFIED snapshot carrying coordinates is rejected", async () => {
    // "verified: false" must not become a loophole for smuggling a destination.
    await assertFails(setDoc(doc(salesRep, "orders", "snapBad7"), newOrder({
      clinicDocId: "clVerified",
      clinicLat: 14.5995,
      clinicLng: 120.9842,
      clinicLocationVerified: false,
    })));
  });

  await check("Nsnap8 an out-of-bounds clinic radius cannot be inherited", async () => {
    await assertFails(setDoc(doc(salesRep, "orders", "snapBad8"), newOrder({
      clinicDocId: "clBadRadius",
      clinicId: "CLN-5000",
      clinicLat: 14.6,
      clinicLng: 120.99,
      clinicGeofenceRadiusM: 5000,
      clinicLocationVerified: true,
    })));
  });

  await check("Nsnap9 sales rep cannot mutate the snapshot after creation", async () => {
    for (const patch of [
      { clinicLat: 1.1 },
      { clinicLng: 2.2 },
      { clinicGeofenceRadiusM: 1000 },
      { clinicLocationVerified: false },
      { clinicDocId: "clUnverified" },
      { clinicId: "CLN-0000" },
    ]) {
      await assertFails(updateDoc(doc(salesRep, "orders", "ordWithSnapshot"), patch));
    }
  });

  await check("Nsnap10 dispatcher and rider cannot write snapshot fields", async () => {
    for (const db of [dispatcher, rider]) {
      await assertFails(updateDoc(doc(db, "orders", "ordWithSnapshot"), {
        clinicLat: 1.1,
        updatedAt: serverTimestamp(),
      }));
      await assertFails(updateDoc(doc(db, "orders", "ordWithSnapshot"), {
        clinicGeofenceRadiusM: 999,
        updatedAt: serverTimestamp(),
      }));
    }
  });

  // ---- Phase 02A hardening: snapshot identity + timestamp provenance ----

  await check("Psnap7 a clinic with NO business id yields an order without one", async () => {
    await assertSucceeds(setDoc(doc(salesRep, "orders", "snapOk7"), newOrder({
      clinicDocId: "clNoBusinessId",
      clinicLat: 13.0,
      clinicLng: 123.0,
      clinicGeofenceRadiusM: 250,
      clinicLocationVerified: true,
      clinicLocationSnapshotAt: serverTimestamp(),
    })));
  });

  await check("Psnap8 a snapshot copying the clinic's real source timestamp is accepted", async () => {
    await assertSucceeds(setDoc(doc(salesRep, "orders", "snapOk8"), newOrder({
      clinicDocId: "clStamped",
      clinicId: "CLN-7777",
      clinicLat: 12.0,
      clinicLng: 121.0,
      clinicGeofenceRadiusM: 200,
      clinicLocationVerified: true,
      clinicLocationUpdatedAt: CLINIC_STAMP,
      clinicLocationSnapshotAt: serverTimestamp(),
    })));
  });

  await check("Nsnap11 a forged clinicLocationSnapshotAt is rejected", async () => {
    // A client-chosen time would let an order misrepresent how fresh its
    // destination copy is. Only the server's request time is acceptable.
    await assertFails(setDoc(doc(salesRep, "orders", "snapBad11"), newOrder({
      clinicDocId: "clVerified",
      clinicId: "CLN-9123",
      clinicLat: 14.5995,
      clinicLng: 120.9842,
      clinicGeofenceRadiusM: 150,
      clinicLocationVerified: true,
      clinicLocationSnapshotAt: new Date("2020-01-01T00:00:00.000Z"),
    })));
  });

  await check("Nsnap12 a clinicLocationUpdatedAt that is not the clinic's is rejected", async () => {
    await assertFails(setDoc(doc(salesRep, "orders", "snapBad12"), newOrder({
      clinicDocId: "clStamped",
      clinicId: "CLN-7777",
      clinicLat: 12.0,
      clinicLng: 121.0,
      clinicGeofenceRadiusM: 200,
      clinicLocationVerified: true,
      clinicLocationUpdatedAt: new Date("2020-01-01T00:00:00.000Z"),
      clinicLocationSnapshotAt: serverTimestamp(),
    })));
  });

  await check("Nsnap13 the document id cannot be substituted into the business id slot", async () => {
    await assertFails(setDoc(doc(salesRep, "orders", "snapBad13"), newOrder({
      clinicDocId: "clVerified",
      clinicId: "clVerified", // document id in the business id field
      clinicLat: 14.5995,
      clinicLng: 120.9842,
      clinicGeofenceRadiusM: 150,
      clinicLocationVerified: true,
      clinicLocationSnapshotAt: serverTimestamp(),
    })));
  });

  await check("Nsnap14 a business id supplied for a clinic that has none is rejected", async () => {
    await assertFails(setDoc(doc(salesRep, "orders", "snapBad14"), newOrder({
      clinicDocId: "clNoBusinessId",
      clinicId: "CLN-0001", // the clinic has no business id at all
      clinicLat: 13.0,
      clinicLng: 123.0,
      clinicGeofenceRadiusM: 250,
      clinicLocationVerified: true,
      clinicLocationSnapshotAt: serverTimestamp(),
    })));
  });

  await check("Nsnap15 a snapshot with no clinicLocationSnapshotAt is rejected", async () => {
    // Omitting the stamp must not be a way around Nsnap11.
    await assertFails(setDoc(doc(salesRep, "orders", "snapBad15"), newOrder({
      clinicDocId: "clVerified",
      clinicId: "CLN-9123",
      clinicLat: 14.5995,
      clinicLng: 120.9842,
      clinicGeofenceRadiusM: 150,
      clinicLocationVerified: true,
    })));
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
