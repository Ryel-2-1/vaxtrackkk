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

    // ---- rider-assignment fixtures (workflow checkpoint 1) ----
    await setDoc(doc(db, "users", "disabledRider1"), { role: "rider", status: "disabled", email: "dr@x.com" });
    await setDoc(doc(db, "users", "rejectedRider1"), { role: "rider", status: "rejected", email: "rr@x.com" });

    // One order per positive case, since a successful assignment consumes it.
    for (const id of ["ordAssignOk", "ordAssignOk2", "ordAssignSame", "ordAssignLater"]) {
      await setDoc(doc(db, "orders", id), {
        createdByUid: salesRepUid, status: "pending_dispatch", assignedRiderId: null,
      });
    }
    // Rejection fixtures.
    await setDoc(doc(db, "orders", "ordAssignBadStatus"), {
      createdByUid: salesRepUid, status: "loading", assignedRiderId: null,
    });
    await setDoc(doc(db, "orders", "ordAssignTaken"), {
      createdByUid: salesRepUid, status: "pending_dispatch", assignedRiderId: otherRiderUid,
    });
    await setDoc(doc(db, "orders", "ordAssignReject"), {
      createdByUid: salesRepUid, status: "pending_dispatch", assignedRiderId: null,
    });

    // ---- lifecycle fixtures (workflow checkpoint 2) ----
    // One order per status, per actor under test, since a successful
    // transition consumes the fixture.
    const lifecycle = {
      lcAssigned: "assigned",
      lcAssigned2: "assigned",
      lcAssigned3: "assigned",
      lcLoading: "loading",
      lcLoading2: "loading",
      lcLoading3: "loading",
      lcTransit: "in_transit",
      lcTransit2: "in_transit",
      lcTransit3: "in_transit",
      lcTransit4: "in_transit",
      lcTransit5: "in_transit",
      lcDelayed: "delayed",
      lcDelayed2: "delayed",
      lcDelayed3: "delayed",
      lcPending: "pending_dispatch",
      lcPending2: "pending_dispatch",
      lcDelivered: "delivered",
      lcCancelled: "cancelled",
    };
    for (const [id, status] of Object.entries(lifecycle)) {
      await setDoc(doc(db, "orders", id), {
        createdByUid: salesRepUid,
        status,
        assignedRiderId: status === "pending_dispatch" ? null : riderUid,
        isLoaded: status === "loading",
        clinicName: "Lifecycle Clinic",
      });
    }
    // Assigned to somebody else — used for the wrong-rider cases.
    await setDoc(doc(db, "orders", "lcOtherRider"), {
      createdByUid: salesRepUid,
      status: "in_transit",
      assignedRiderId: otherRiderUid,
      clinicName: "Lifecycle Clinic",
    });

    // ---- failed-delivery fixtures (workflow checkpoint 3) ----
    const failFixtures = {
      fdTransit: "in_transit",
      fdTransit2: "in_transit",
      fdTransit3: "in_transit",
      fdDelayed: "delayed",
      fdAssigned: "assigned",
      fdLoading: "loading",
      fdFailed: "delivery_failed",
      fdFailed2: "delivery_failed",
      fdFailed3: "delivery_failed",
      fdFailed4: "delivery_failed",
      fdFailed5: "delivery_failed",
      fdFailed6: "delivery_failed",
      fdFailed7: "delivery_failed",
    };
    for (const [id, status] of Object.entries(failFixtures)) {
      await setDoc(doc(db, "orders", id), {
        createdByUid: salesRepUid,
        status,
        assignedRiderId: riderUid,
        clinicName: "Failure Clinic",
        ...(status === "delivery_failed"
          ? {
              deliveryFailureReason: "Clinic permanently closed",
              deliveryFailedAt: CLINIC_STAMP,
              deliveryFailedByUid: riderUid,
            }
          : {}),
      });
    }
    // A failed order belonging to another rider.
    await setDoc(doc(db, "orders", "fdOtherRider"), {
      createdByUid: salesRepUid,
      status: "in_transit",
      assignedRiderId: otherRiderUid,
      clinicName: "Failure Clinic",
    });

    // Real staging shapes that must stay readable and must NOT be repaired
    // here: an assignment pointing at a user document that no longer exists,
    // and an order carrying only a rider name.
    await setDoc(doc(db, "orders", "ordOrphanAssignment"), {
      createdByUid: salesRepUid, status: "in_transit", assignedRiderId: "ghostRiderUid",
      assignedRiderName: "Ghost Rider",
    });
    await setDoc(doc(db, "orders", "ordNameOnly"), {
      createdByUid: salesRepUid, status: "delayed", assignedRiderName: "Name Only Rider",
    });

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
    // `assignedAt` is now required to be server-stamped (workflow checkpoint 1)
    // — it used to be the client string "t". The field list is otherwise
    // unchanged; this case still proves the dispatcher allowlist accepts the
    // full assignment payload.
    await assertSucceeds(updateDoc(doc(dispatcher, "orders", "ordSR1"), {
      status: "assigned",
      assignedRiderId: riderUid,
      assignedRiderName: "R",
      assignedRiderPhone: "0917",
      assignedAt: serverTimestamp(),
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

  await check("P11 rider updates allowed status/location/proof fields on their own order", async () => {
    // Completing in_transit → delivered. The status audit and deliveredAt are
    // now required to be server-stamped (workflow checkpoint 2); they used to
    // be the client strings "t". The allowlisted field set is unchanged, so
    // this still proves a rider may write status, location and proof together.
    await assertSucceeds(updateDoc(doc(rider, "orders", "ordRider1"), {
      status: "delivered",
      deliveredAt: serverTimestamp(),
      lastLocation: { lat: 14.5, lng: 121.0 },
      lastLocationUpdate: "t",
      locationAccuracy: 5,
      heading: 0,
      speed: 0,
      proofOfDeliveryUrl: "https://x/p.jpg",
      statusUpdatedAt: serverTimestamp(),
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

  // A snapshot-less legacy order still moves through the SAME lifecycle as any
  // other. These now carry the fields each transition requires (workflow
  // checkpoint 2) — previously they were bare status writes, which the rules no
  // longer accept from anyone. The point of the cases is unchanged: missing
  // Phase 02A snapshot fields must not block the lifecycle.
  await check("Psnap5 legacy order (no snapshot) keeps its dispatcher lifecycle", async () => {
    // assigned → loading, via the cargo-loading confirmation.
    await assertSucceeds(updateDoc(doc(dispatcher, "orders", "ordLegacyNoSnapshot"), {
      status: "loading",
      isLoaded: true,
      loadedAt: serverTimestamp(),
      statusUpdatedAt: serverTimestamp(),
      statusUpdatedByUid: dispatcherUid,
      updatedAt: serverTimestamp(),
    }));
    // loading → in_transit, via finalize dispatch.
    await assertSucceeds(updateDoc(doc(dispatcher, "orders", "ordLegacyNoSnapshot"), {
      status: "in_transit",
      dispatchedAt: serverTimestamp(),
      startedAt: serverTimestamp(),
      statusUpdatedAt: serverTimestamp(),
      statusUpdatedByUid: dispatcherUid,
      updatedAt: serverTimestamp(),
    }));
  });

  await check("Psnap6 legacy order keeps its rider lifecycle", async () => {
    // The rider takes over from in_transit: delay, resume, complete.
    await assertSucceeds(updateDoc(doc(rider, "orders", "ordLegacyNoSnapshot"), {
      status: "delayed",
      delayReason: "Traffic on the bridge",
      delayedAt: serverTimestamp(),
      statusUpdatedAt: serverTimestamp(),
      statusUpdatedByUid: riderUid,
      updatedAt: serverTimestamp(),
    }));
    await assertSucceeds(updateDoc(doc(rider, "orders", "ordLegacyNoSnapshot"), {
      status: "in_transit",
      startedAt: serverTimestamp(),
      statusUpdatedAt: serverTimestamp(),
      statusUpdatedByUid: riderUid,
      updatedAt: serverTimestamp(),
    }));
    await assertSucceeds(updateDoc(doc(rider, "orders", "ordLegacyNoSnapshot"), {
      status: "delivered",
      deliveredAt: serverTimestamp(),
      statusUpdatedAt: serverTimestamp(),
      statusUpdatedByUid: riderUid,
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

  // =========================================================================
  // Rider assignment (workflow checkpoint 1)
  //
  // The rules must reach the same verdict as assignRiderToOrder's transaction
  // even when the client is bypassed entirely.
  // =========================================================================

  /** A well-formed assignment payload, overridable per case. */
  const assignment = (riderId, over = {}) => ({
    status: "assigned",
    assignedRiderId: riderId,
    assignedRiderName: "QA Rider",
    assignedAt: serverTimestamp(),
    assignedByUid: dispatcherUid,
    updatedAt: serverTimestamp(),
    ...over,
  });

  await check("Passign1 dispatcher assigns an approved rider to a pending order", async () => {
    await assertSucceeds(updateDoc(doc(dispatcher, "orders", "ordAssignOk"), assignment(riderUid)));
  });

  await check("Passign2 the same approved rider may take another order (no per-rider limit)", async () => {
    await assertSucceeds(updateDoc(doc(dispatcher, "orders", "ordAssignSame"), assignment(riderUid)));
  });

  await check("Passign3 assignment without the optional display name is allowed", async () => {
    const payload = assignment(otherRiderUid);
    delete payload.assignedRiderName;
    await assertSucceeds(updateDoc(doc(dispatcher, "orders", "ordAssignOk2"), payload));
  });

  await check("Nassign1 cannot assign an order that is not pending_dispatch", async () => {
    await assertFails(updateDoc(doc(dispatcher, "orders", "ordAssignBadStatus"), assignment(riderUid)));
  });

  await check("Nassign2 cannot assign an order that already has a rider", async () => {
    await assertFails(updateDoc(doc(dispatcher, "orders", "ordAssignTaken"), assignment(riderUid)));
  });

  await check("Nassign3 cannot assign a uid with no users document", async () => {
    await assertFails(updateDoc(doc(dispatcher, "orders", "ordAssignReject"), assignment("noSuchUser")));
  });

  await check("Nassign4 an employee id cannot substitute for the rider UID", async () => {
    // A display identifier is not a document id, so exists() fails.
    await assertFails(updateDoc(doc(dispatcher, "orders", "ordAssignReject"), assignment("EMP-4432")));
  });

  await check("Nassign5 cannot assign an admin, dispatcher or sales rep account", async () => {
    for (const uid of [adminUid, dispatcherUid, salesRepUid]) {
      await assertFails(updateDoc(doc(dispatcher, "orders", "ordAssignReject"), assignment(uid)));
    }
  });

  await check("Nassign6 cannot assign a pending, disabled or rejected rider", async () => {
    for (const uid of [pendingRiderUid, "disabledRider1", "rejectedRider1"]) {
      await assertFails(updateDoc(doc(dispatcher, "orders", "ordAssignReject"), assignment(uid)));
    }
  });

  await check("Nassign7 assignedRiderId must be a non-empty string", async () => {
    for (const bad of ["", null]) {
      await assertFails(updateDoc(doc(dispatcher, "orders", "ordAssignReject"), assignment(bad)));
    }
  });

  await check("Nassign8 assignedAt must be server-stamped, not client-chosen", async () => {
    await assertFails(updateDoc(doc(dispatcher, "orders", "ordAssignReject"),
      assignment(riderUid, { assignedAt: new Date("2020-01-01T00:00:00Z") })));
  });

  await check("Nassign9 the assignment audit must name the caller", async () => {
    await assertFails(updateDoc(doc(dispatcher, "orders", "ordAssignReject"),
      assignment(riderUid, { assignedByUid: adminUid })));
    await assertFails(updateDoc(doc(dispatcher, "orders", "ordAssignReject"),
      assignment(riderUid, { assignedByUid: riderUid })));
  });

  await check("Nassign10 the new status must be exactly 'assigned'", async () => {
    for (const status of ["in_transit", "delivered", "loading"]) {
      await assertFails(updateDoc(doc(dispatcher, "orders", "ordAssignReject"),
        assignment(riderUid, { status })));
    }
  });

  // ---- assignment identity is frozen outside a valid assignment ----

  await check("Nassign11 dispatcher cannot move an assigned order to another rider", async () => {
    // ordAssignOk is now assigned to riderUid.
    await assertFails(updateDoc(doc(dispatcher, "orders", "ordAssignOk"), {
      assignedRiderId: otherRiderUid, updatedAt: serverTimestamp(),
    }));
  });

  await check("Nassign12 dispatcher cannot smuggle an identity change into a status update", async () => {
    await assertFails(updateDoc(doc(dispatcher, "orders", "ordAssignOk"), {
      status: "in_transit",
      assignedRiderId: otherRiderUid,
      statusUpdatedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(doc(dispatcher, "orders", "ordAssignOk"), {
      status: "in_transit",
      assignedRiderName: "Someone Else",
      statusUpdatedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
  });

  await check("Nassign13 rider cannot reassign their own order", async () => {
    await assertFails(updateDoc(doc(rider, "orders", "ordRider1"), {
      assignedRiderId: otherRiderUid, updatedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(doc(rider, "orders", "ordRider1"), {
      assignedRiderName: "Impostor", updatedAt: serverTimestamp(),
    }));
  });

  await check("Passign4 ordinary dispatcher lifecycle updates still work", async () => {
    // No assignment identity touched — the existing flow must not regress.
    await assertSucceeds(updateDoc(doc(dispatcher, "orders", "ordAssignOk"), {
      status: "loading",
      isLoaded: true,
      loadedAt: serverTimestamp(),
      statusUpdatedAt: serverTimestamp(),
      statusUpdatedByUid: dispatcherUid,
      updatedAt: serverTimestamp(),
    }));
  });

  await check("Passign5 rider status/location writes still work", async () => {
    await assertSucceeds(updateDoc(doc(rider, "orders", "ordRider1"), {
      status: "delivered",
      deliveredAt: serverTimestamp(),
      statusUpdatedAt: serverTimestamp(),
      statusUpdatedByUid: riderUid,
      updatedAt: serverTimestamp(),
    }));
  });

  await check("Passign6 admin retains assignment repair authority", async () => {
    await assertSucceeds(updateDoc(doc(admin, "orders", "ordOrphanAssignment"), {
      assignedRiderId: riderUid, updatedAt: serverTimestamp(),
    }));
  });

  // ---- legacy / orphaned documents stay readable ----

  await check("Passign7 orphaned and name-only orders remain readable by admin + dispatcher", async () => {
    for (const db of [admin, dispatcher]) {
      await assertSucceeds(getDoc(doc(db, "orders", "ordNameOnly")));
    }
    // ordOrphanAssignment was just repaired above; ordNameOnly still has no id.
    await assertSucceeds(getDoc(doc(salesRep, "orders", "ordNameOnly")));
  });

  await check("Nassign14 a name-only order is still not readable by an unrelated rider", async () => {
    await assertFails(getDoc(doc(rider, "orders", "ordNameOnly")));
  });

  await check("Passign8 the clinic snapshot stays immutable during assignment", async () => {
    await assertFails(updateDoc(doc(dispatcher, "orders", "ordAssignLater"),
      assignment(riderUid, { clinicLat: 1.23 })));
    // and the plain assignment on the same order still succeeds
    await assertSucceeds(updateDoc(doc(dispatcher, "orders", "ordAssignLater"), assignment(riderUid)));
  });

  // =========================================================================
  // Order lifecycle (workflow checkpoint 2)
  //
  // Dispatcher: pending_dispatch → assigned → loading → in_transit,
  //             plus any non-terminal → cancelled (reason required).
  // Rider:      in_transit ⇄ delayed, and either → delivered.
  // Nothing else, for anyone.
  // =========================================================================

  const audit = (uid) => ({
    statusUpdatedAt: serverTimestamp(),
    statusUpdatedByUid: uid,
    updatedAt: serverTimestamp(),
  });
  const loadConfirm = () => ({
    status: "loading",
    isLoaded: true,
    loadedAt: serverTimestamp(),
    ...audit(dispatcherUid),
  });
  const dispatchRun = () => ({
    status: "in_transit",
    dispatchedAt: serverTimestamp(),
    startedAt: serverTimestamp(),
    ...audit(dispatcherUid),
  });
  const cancelWith = (reason) => ({
    status: "cancelled",
    cancelReason: reason,
    cancelledAt: serverTimestamp(),
    ...audit(dispatcherUid),
  });
  const delayWith = (reason) => ({
    status: "delayed",
    delayReason: reason,
    delayedAt: serverTimestamp(),
    ...audit(riderUid),
  });
  const resume = () => ({
    status: "in_transit",
    startedAt: serverTimestamp(),
    ...audit(riderUid),
  });
  const complete = () => ({
    status: "delivered",
    deliveredAt: serverTimestamp(),
    ...audit(riderUid),
  });

  // ---- dispatcher: allowed ----

  await check("Plc1 dispatcher confirms loading (assigned → loading)", async () => {
    await assertSucceeds(updateDoc(doc(dispatcher, "orders", "lcAssigned"), loadConfirm()));
  });

  await check("Plc2 dispatcher may re-tick loading metadata without moving the order", async () => {
    await assertSucceeds(updateDoc(doc(dispatcher, "orders", "lcLoading"), {
      isLoaded: false, loadedAt: null, loadedByUid: null, loadedByEmail: null,
      updatedAt: serverTimestamp(),
    }));
  });

  await check("Plc3 dispatcher finalizes dispatch (loading → in_transit)", async () => {
    await assertSucceeds(updateDoc(doc(dispatcher, "orders", "lcLoading2"), dispatchRun()));
  });

  await check("Plc4 dispatcher cancels a non-terminal order with a reason", async () => {
    await assertSucceeds(updateDoc(doc(dispatcher, "orders", "lcPending"), cancelWith("Clinic closed")));
    await assertSucceeds(updateDoc(doc(dispatcher, "orders", "lcAssigned2"), cancelWith("Rider unavailable")));
    await assertSucceeds(updateDoc(doc(dispatcher, "orders", "lcLoading3"), cancelWith("Cold chain breach")));
    await assertSucceeds(updateDoc(doc(dispatcher, "orders", "lcTransit"), cancelWith("Recalled")));
    await assertSucceeds(updateDoc(doc(dispatcher, "orders", "lcDelayed"), cancelWith("Abandoned")));
  });

  // ---- dispatcher: forbidden ----

  await check("Nlc1 dispatcher cannot skip loading (assigned → in_transit)", async () => {
    await assertFails(updateDoc(doc(dispatcher, "orders", "lcAssigned3"), dispatchRun()));
  });

  await check("Nlc2 dispatcher cannot skip assignment (pending_dispatch → loading)", async () => {
    await assertFails(updateDoc(doc(dispatcher, "orders", "lcPending2"), loadConfirm()));
  });

  await check("Nlc3 dispatcher cannot deliver, delay or resume", async () => {
    await assertFails(updateDoc(doc(dispatcher, "orders", "lcTransit2"), {
      status: "delivered", deliveredAt: serverTimestamp(), ...audit(dispatcherUid),
    }));
    await assertFails(updateDoc(doc(dispatcher, "orders", "lcTransit2"), {
      status: "delayed", delayReason: "Traffic", delayedAt: serverTimestamp(), ...audit(dispatcherUid),
    }));
    await assertFails(updateDoc(doc(dispatcher, "orders", "lcDelayed2"), {
      status: "in_transit", startedAt: serverTimestamp(), ...audit(dispatcherUid),
    }));
  });

  await check("Nlc4 dispatcher cannot promote to loading without confirming the load", async () => {
    await assertFails(updateDoc(doc(dispatcher, "orders", "lcAssigned3"), {
      status: "loading", ...audit(dispatcherUid),
    }));
    await assertFails(updateDoc(doc(dispatcher, "orders", "lcAssigned3"), {
      status: "loading", isLoaded: false, loadedAt: serverTimestamp(), ...audit(dispatcherUid),
    }));
  });

  await check("Nlc5 cancellation requires a meaningful, bounded reason", async () => {
    for (const reason of ["", "   ", "\n\t", "x".repeat(501)]) {
      await assertFails(updateDoc(doc(dispatcher, "orders", "lcAssigned3"), cancelWith(reason)));
    }
    // Missing entirely.
    await assertFails(updateDoc(doc(dispatcher, "orders", "lcAssigned3"), {
      status: "cancelled", cancelledAt: serverTimestamp(), ...audit(dispatcherUid),
    }));
  });

  await check("Nlc6 cancellation timestamps and audit cannot be client-forged", async () => {
    await assertFails(updateDoc(doc(dispatcher, "orders", "lcAssigned3"), {
      ...cancelWith("Clinic closed"), cancelledAt: new Date("2020-01-01T00:00:00Z"),
    }));
    await assertFails(updateDoc(doc(dispatcher, "orders", "lcAssigned3"), {
      ...cancelWith("Clinic closed"), statusUpdatedAt: "t",
    }));
    await assertFails(updateDoc(doc(dispatcher, "orders", "lcAssigned3"), {
      ...cancelWith("Clinic closed"), statusUpdatedByUid: adminUid,
    }));
  });

  await check("Nlc7 dispatcher cannot resurrect a terminal order", async () => {
    for (const id of ["lcDelivered", "lcCancelled"]) {
      await assertFails(updateDoc(doc(dispatcher, "orders", id), loadConfirm()));
      await assertFails(updateDoc(doc(dispatcher, "orders", id), dispatchRun()));
      await assertFails(updateDoc(doc(dispatcher, "orders", id), cancelWith("Reopen")));
    }
  });

  await check("Nlc8 dispatcher cannot write an arbitrary status string", async () => {
    for (const status of ["delivery_failed", "picked_up", "arrived", "completed", "DONE", ""]) {
      await assertFails(updateDoc(doc(dispatcher, "orders", "lcAssigned3"), {
        status, ...audit(dispatcherUid),
      }));
    }
  });

  await check("Nlc9 dispatcher cannot touch loading metadata once the order has left", async () => {
    await assertFails(updateDoc(doc(dispatcher, "orders", "lcTransit2"), {
      isLoaded: false, updatedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(doc(dispatcher, "orders", "lcDelivered"), {
      isLoaded: true, loadedAt: serverTimestamp(), updatedAt: serverTimestamp(),
    }));
  });

  await check("Nlc10 dispatcher cannot change the clinic snapshot during a lifecycle write", async () => {
    await assertFails(updateDoc(doc(dispatcher, "orders", "lcAssigned3"), {
      ...loadConfirm(), clinicLat: 1.234,
    }));
  });

  // ---- rider: allowed ----

  await check("Plc5 rider reports a delay (in_transit → delayed)", async () => {
    await assertSucceeds(updateDoc(doc(rider, "orders", "lcTransit3"), delayWith("Heavy traffic")));
  });

  await check("Plc6 rider resumes transit (delayed → in_transit)", async () => {
    await assertSucceeds(updateDoc(doc(rider, "orders", "lcDelayed3"), resume()));
  });

  await check("Plc7 rider completes from in_transit and from delayed", async () => {
    await assertSucceeds(updateDoc(doc(rider, "orders", "lcTransit4"), complete()));
    await assertSucceeds(updateDoc(doc(rider, "orders", "lcTransit3"), complete())); // now delayed
  });

  await check("Plc8 rider location writes still need no status change", async () => {
    // Continuous tracking is unchanged by this checkpoint.
    await assertSucceeds(updateDoc(doc(rider, "orders", "lcTransit5"), {
      lastLocation: { lat: 14.6, lng: 121.0 },
      lastLocationUpdate: serverTimestamp(),
      locationAccuracy: 8, heading: 90, speed: 3.4,
      updatedAt: serverTimestamp(),
    }));
  });

  // ---- rider: forbidden ----

  await check("Nlc11 rider cannot start loading or dispatch", async () => {
    await assertFails(updateDoc(doc(rider, "orders", "lcAssigned3"), {
      status: "loading", isLoaded: true, ...audit(riderUid),
    }));
    await assertFails(updateDoc(doc(rider, "orders", "lcLoading"), {
      status: "in_transit", startedAt: serverTimestamp(), ...audit(riderUid),
    }));
  });

  await check("Nlc12 rider cannot cancel", async () => {
    await assertFails(updateDoc(doc(rider, "orders", "lcTransit5"), {
      status: "cancelled", cancelReason: "Cannot be bothered",
      cancelledAt: serverTimestamp(), ...audit(riderUid),
    }));
  });

  await check("Nlc13 rider cannot move an order backwards", async () => {
    for (const status of ["pending_dispatch", "assigned", "loading"]) {
      await assertFails(updateDoc(doc(rider, "orders", "lcTransit5"), {
        status, ...audit(riderUid),
      }));
    }
  });

  await check("Nlc14 rider cannot write an arbitrary status string", async () => {
    for (const status of ["delivery_failed", "arrived", "completed", "DELIVERED", ""]) {
      await assertFails(updateDoc(doc(rider, "orders", "lcTransit5"), {
        status, ...audit(riderUid),
      }));
    }
  });

  await check("Nlc15 rider cannot resurrect a terminal order", async () => {
    await assertFails(updateDoc(doc(rider, "orders", "lcTransit4"), resume())); // now delivered
    await assertFails(updateDoc(doc(rider, "orders", "lcTransit4"), delayWith("Too late")));
  });

  await check("Nlc16 a delay needs a meaningful, bounded reason", async () => {
    for (const reason of ["", "   ", "x".repeat(501)]) {
      await assertFails(updateDoc(doc(rider, "orders", "lcTransit5"), delayWith(reason)));
    }
    await assertFails(updateDoc(doc(rider, "orders", "lcTransit5"), {
      status: "delayed", delayedAt: serverTimestamp(), ...audit(riderUid),
    }));
  });

  await check("Nlc17 rider timestamps and audit cannot be client-forged", async () => {
    await assertFails(updateDoc(doc(rider, "orders", "lcTransit5"), {
      ...complete(), deliveredAt: new Date("2020-01-01T00:00:00Z"),
    }));
    await assertFails(updateDoc(doc(rider, "orders", "lcTransit5"), {
      ...complete(), statusUpdatedByUid: dispatcherUid,
    }));
    await assertFails(updateDoc(doc(rider, "orders", "lcTransit5"), {
      ...delayWith("Traffic"), delayedAt: "t",
    }));
  });

  await check("Nlc18 a rider cannot act on another rider's order", async () => {
    await assertFails(updateDoc(doc(rider, "orders", "lcOtherRider"), complete()));
    await assertFails(updateDoc(doc(rider, "orders", "lcOtherRider"), delayWith("Traffic")));
    await assertFails(getDoc(doc(rider, "orders", "lcOtherRider")));
  });

  await check("Nlc19 sales rep cannot change delivery status at all", async () => {
    for (const payload of [complete(), delayWith("Traffic"), cancelWith("No longer needed")]) {
      await assertFails(updateDoc(doc(salesRep, "orders", "ordSR1"), payload));
    }
  });

  // =========================================================================
  // Failed delivery + dispatcher recovery (workflow checkpoint 3)
  //
  // Rider:      in_transit | delayed → delivery_failed (reason required)
  // Dispatcher: delivery_failed → assigned (approved rider) | cancelled
  // =========================================================================

  const failWith = (reason) => ({
    status: "delivery_failed",
    deliveryFailureReason: reason,
    deliveryFailedAt: serverTimestamp(),
    deliveryFailedByUid: riderUid,
    ...audit(riderUid),
  });
  const recoverTo = (uid, over = {}) => ({
    status: "assigned",
    assignedRiderId: uid,
    assignedAt: serverTimestamp(),
    assignedByUid: dispatcherUid,
    reassignedAt: serverTimestamp(),
    reassignedByUid: dispatcherUid,
    previousAssignedRiderId: riderUid,
    isLoaded: false,
    ...audit(dispatcherUid),
    ...over,
  });

  // ---- rider failure: allowed ----

  await check("Pfd1 assigned rider reports failure from in_transit", async () => {
    await assertSucceeds(updateDoc(doc(rider, "orders", "fdTransit"), failWith("Clinic closed")));
  });

  await check("Pfd2 assigned rider reports failure from delayed", async () => {
    await assertSucceeds(updateDoc(doc(rider, "orders", "fdDelayed"), failWith("Address does not exist")));
  });

  // ---- rider failure: forbidden ----

  await check("Nfd1 a delivery cannot fail from assigned or loading", async () => {
    await assertFails(updateDoc(doc(rider, "orders", "fdAssigned"), failWith("Too early")));
    await assertFails(updateDoc(doc(rider, "orders", "fdLoading"), failWith("Too early")));
  });

  await check("Nfd2 the failure reason must be meaningful and bounded", async () => {
    for (const reason of ["", "   ", "\n\t", "x".repeat(501)]) {
      await assertFails(updateDoc(doc(rider, "orders", "fdTransit2"), failWith(reason)));
    }
    // Missing entirely.
    await assertFails(updateDoc(doc(rider, "orders", "fdTransit2"), {
      status: "delivery_failed",
      deliveryFailedAt: serverTimestamp(),
      deliveryFailedByUid: riderUid,
      ...audit(riderUid),
    }));
  });

  await check("Nfd3 failure timestamps and reporter cannot be forged", async () => {
    await assertFails(updateDoc(doc(rider, "orders", "fdTransit2"), {
      ...failWith("Clinic closed"), deliveryFailedAt: new Date("2020-01-01T00:00:00Z"),
    }));
    // Attributing the report to another rider.
    await assertFails(updateDoc(doc(rider, "orders", "fdTransit2"), {
      ...failWith("Clinic closed"), deliveryFailedByUid: otherRiderUid,
    }));
    await assertFails(updateDoc(doc(rider, "orders", "fdTransit2"), {
      ...failWith("Clinic closed"), statusUpdatedAt: "t",
    }));
  });

  await check("Nfd4 a rider cannot fail another rider's delivery", async () => {
    await assertFails(updateDoc(doc(rider, "orders", "fdOtherRider"), failWith("Not mine")));
  });

  await check("Nfd5 a dispatcher cannot report a delivery failure", async () => {
    await assertFails(updateDoc(doc(dispatcher, "orders", "fdTransit2"), {
      ...failWith("Clinic closed"), deliveryFailedByUid: dispatcherUid, ...audit(dispatcherUid),
    }));
  });

  await check("Nfd6 a rider cannot move a failed delivery anywhere", async () => {
    for (const payload of [resume(), complete(), delayWith("Traffic")]) {
      await assertFails(updateDoc(doc(rider, "orders", "fdFailed"), payload));
    }
    // ...including retrying it themselves.
    await assertFails(updateDoc(doc(rider, "orders", "fdFailed"), {
      status: "assigned", ...audit(riderUid),
    }));
  });

  // ---- dispatcher recovery: allowed ----

  await check("Pfd3 dispatcher retries a failed order with the same rider", async () => {
    await assertSucceeds(updateDoc(doc(dispatcher, "orders", "fdFailed"), recoverTo(riderUid)));
  });

  await check("Pfd4 dispatcher reassigns a failed order to another approved rider", async () => {
    await assertSucceeds(updateDoc(doc(dispatcher, "orders", "fdFailed2"), recoverTo(otherRiderUid)));
  });

  await check("Pfd5 dispatcher cancels a failed order with a reason", async () => {
    await assertSucceeds(updateDoc(doc(dispatcher, "orders", "fdFailed3"), cancelWith("Clinic will not reopen")));
  });

  // ---- dispatcher recovery: forbidden ----

  await check("Nfd7 recovery requires an existing, approved rider", async () => {
    await assertFails(updateDoc(doc(dispatcher, "orders", "fdFailed4"), recoverTo("noSuchUser")));
    await assertFails(updateDoc(doc(dispatcher, "orders", "fdFailed4"), recoverTo("EMP-4432")));
    for (const uid of [adminUid, dispatcherUid, salesRepUid, pendingRiderUid, "disabledRider1", "rejectedRider1"]) {
      await assertFails(updateDoc(doc(dispatcher, "orders", "fdFailed4"), recoverTo(uid)));
    }
  });

  await check("Nfd8 recovery timestamps and audit cannot be forged", async () => {
    await assertFails(updateDoc(doc(dispatcher, "orders", "fdFailed4"), {
      ...recoverTo(riderUid), reassignedAt: new Date("2020-01-01T00:00:00Z"),
    }));
    await assertFails(updateDoc(doc(dispatcher, "orders", "fdFailed4"), {
      ...recoverTo(riderUid), reassignedByUid: adminUid,
    }));
    await assertFails(updateDoc(doc(dispatcher, "orders", "fdFailed4"), {
      ...recoverTo(riderUid), assignedAt: "t",
    }));
  });

  await check("Nfd9 recovery cannot erase the failure record", async () => {
    for (const field of ["deliveryFailureReason", "deliveryFailedAt", "deliveryFailedByUid"]) {
      await assertFails(updateDoc(doc(dispatcher, "orders", "fdFailed4"), {
        ...recoverTo(riderUid), [field]: null,
      }));
    }
    await assertFails(updateDoc(doc(dispatcher, "orders", "fdFailed4"), {
      ...recoverTo(riderUid), deliveryFailureReason: "rewritten",
    }));
  });

  await check("Nfd10 cancelling a failed order cannot erase the failure record", async () => {
    await assertFails(updateDoc(doc(dispatcher, "orders", "fdFailed5"), {
      ...cancelWith("No longer needed"), deliveryFailureReason: "rewritten",
    }));
  });

  await check("Nfd11 a failed order cannot jump straight back into the field", async () => {
    for (const payload of [loadConfirm(), dispatchRun(), {
      status: "delayed", delayReason: "x", delayedAt: serverTimestamp(), ...audit(dispatcherUid),
    }, {
      status: "delivered", deliveredAt: serverTimestamp(), ...audit(dispatcherUid),
    }]) {
      await assertFails(updateDoc(doc(dispatcher, "orders", "fdFailed6"), payload));
    }
  });

  await check("Nfd12 recovery cannot mutate the clinic snapshot", async () => {
    await assertFails(updateDoc(doc(dispatcher, "orders", "fdFailed6"), {
      ...recoverTo(riderUid), clinicLat: 1.234,
    }));
  });

  await check("Nfd13 a terminal order cannot be revived through recovery", async () => {
    for (const id of ["lcDelivered", "lcCancelled"]) {
      await assertFails(updateDoc(doc(dispatcher, "orders", id), recoverTo(riderUid)));
    }
  });

  await check("Nfd14 a sales rep cannot fail or recover an order", async () => {
    await assertFails(updateDoc(doc(salesRep, "orders", "ordSR1"), failWith("Clinic closed")));
    await assertFails(updateDoc(doc(salesRep, "orders", "ordSR1"), recoverTo(riderUid)));
  });

  await check("Pfd6 a recovered order still reads correctly for every role", async () => {
    // fdFailed was recovered in Pfd3; the failure record must still be there.
    await assertSucceeds(getDoc(doc(dispatcher, "orders", "fdFailed")));
    await assertSucceeds(getDoc(doc(admin, "orders", "fdFailed")));
    await assertSucceeds(getDoc(doc(rider, "orders", "fdFailed")));
    await assertSucceeds(getDoc(doc(salesRep, "orders", "fdFailed")));
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
