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
  collection,
  getDocs,
  query,
  where,
} from "firebase/firestore";

const PROJECT_ID = "vaxtrack-rules-test";

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
      port: 8080,
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

  await check("P3 admin writes inventory/clinics/alerts/invoices/counters", async () => {
    await assertSucceeds(setDoc(doc(admin, "inventory", "invAdmin"), { vaccineName: "Y" }));
    await assertSucceeds(setDoc(doc(admin, "clinics", "clAdmin"), { name: "C" }));
    await assertSucceeds(setDoc(doc(admin, "alerts", "alAdmin"), { status: "active" }));
    await assertSucceeds(setDoc(doc(admin, "invoices", "invAdmin1"), { orderId: "x" }));
    await assertSucceeds(setDoc(doc(admin, "counters", "invoice_2027"), { value: 0 }));
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
