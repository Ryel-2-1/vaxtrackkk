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
  orderBy,
  limit,
  serverTimestamp,
  runTransaction,
  Timestamp,
  deleteField,
} from "firebase/firestore";

const PROJECT_ID = "vaxtrack-rules-test";
// A valid, already-reached Manila delivery date for fixture orders.
const FIXTURE_DELIVERY_DATE = "2026-01-01";

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
const freshSalesRepUid = "freshSalesRep1"; // web self-application test
const freshDispatcherUid = "freshDispatcher1"; // web self-application test
const freshAdminApplicantUid = "freshAdminApplicant1"; // must NOT be allowed

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
    // Every order now carries a requested delivery date — the callable refuses
    // one without — and an undated order fails closed at dispatch. Fixtures get
    // a past date so each lifecycle case stays about its own subject; the cases
    // about the date seed their own (see "scheduled dispatch" below). A fixture
    // that sets requestedDeliveryDate itself overrides this.
    const seedOrder = (id, data) =>
      setDoc(doc(db, "orders", id), { requestedDeliveryDate: FIXTURE_DELIVERY_DATE, ...data });
    await setDoc(doc(db, "users", adminUid), { role: "admin", status: "approved", email: "a@x.com" });
    await setDoc(doc(db, "users", dispatcherUid), { role: "dispatcher", status: "approved", email: "d@x.com" });
    await setDoc(doc(db, "users", salesRepUid), { role: "salesrep", status: "approved", email: "s@x.com" });
    await setDoc(doc(db, "users", otherSalesRepUid), { role: "salesrep", status: "approved", email: "s2@x.com" });
    await setDoc(doc(db, "users", riderUid), { role: "rider", status: "approved", email: "r@x.com" });
    await setDoc(doc(db, "users", otherRiderUid), { role: "rider", status: "approved", email: "r2@x.com" });
    await setDoc(doc(db, "users", pendingRiderUid), { role: "rider", status: "pending", email: "p@x.com" });
    await setDoc(doc(db, "users", disabledUid), { role: "dispatcher", status: "disabled", email: "x@x.com" });

    await seedOrder("ordSR1", { createdByUid: salesRepUid, status: "pending_dispatch", assignedRiderId: null });
    await seedOrder("ordSR2", { createdByUid: otherSalesRepUid, status: "pending_dispatch", assignedRiderId: null });
    await seedOrder("ordRider1", { createdByUid: salesRepUid, status: "in_transit", assignedRiderId: riderUid });
    await seedOrder("ordCorrected", {
      createdByUid: salesRepUid, status: "assigned", assignedRiderId: riderUid,
      destinationRevision: 1, doctorId: "doctor1", doctorAddressId: "home",
    });
    await setDoc(doc(db, "orders", "ordCorrected", "destinationCorrections", "revision-1"), {
      revision: 1, correctedByUid: dispatcherUid, reason: "Doctor requested home delivery",
    });
    await setDoc(doc(db, "orders", "ordCorrected", "destinationChangeRequests", "request-2"), {
      status: "pending", proposed: { doctorAddressId: "clinic2" }, reason: "New delivery location",
    });
    await seedOrder("ordRider2", { createdByUid: salesRepUid, status: "in_transit", assignedRiderId: otherRiderUid });
    // A THIRD assigned order with NO alert yet — used to reproduce the real
    // service's transaction upsert, which reads the deterministic alert doc
    // before it exists.
    await seedOrder("ordRider3", { createdByUid: salesRepUid, status: "in_transit", assignedRiderId: riderUid });

    await setDoc(doc(db, "inventory", "inv1"), { vaccineName: "X", quantity: 10 });
    // Stock-correction fixtures: 10 of 100 reserved for open orders.
    await setDoc(doc(db, "inventory", "invCorrect"), {
      vaccineName: "Corr", batchId: "COR-1", expiryDate: "2027-12-31",
      quantity: 100, reservedQuantity: 10, sellingPriceCentavos: 125000,
    });
    await setDoc(doc(db, "inventory", "invCorrectFloor"), {
      vaccineName: "Corr2", batchId: "COR-2", expiryDate: "2027-12-31",
      quantity: 100, reservedQuantity: 10, sellingPriceCentavos: 125000,
    });
    await setDoc(doc(db, "areas", "seed-area"), {
      key: "seed-area",
      name: "Seed Area",
      nameNormalized: "seed area",
      active: true,
    });
    await setDoc(doc(db, "clinics", "cl1"), { name: "Clinic A" });

    // ---- rider-assignment fixtures (workflow checkpoint 1) ----
    await setDoc(doc(db, "users", "disabledRider1"), { role: "rider", status: "disabled", email: "dr@x.com" });
    await setDoc(doc(db, "users", "rejectedRider1"), { role: "rider", status: "rejected", email: "rr@x.com" });

    // One order per positive case, since a successful assignment consumes it.
    for (const id of ["ordAssignOk", "ordAssignOk2", "ordAssignSame", "ordAssignLater"]) {
      await seedOrder(id, {
        createdByUid: salesRepUid, status: "pending_dispatch", assignedRiderId: null,
      });
    }
    // Rejection fixtures.
    await seedOrder("ordAssignBadStatus", {
      createdByUid: salesRepUid, status: "loading", assignedRiderId: null,
    });
    await seedOrder("ordAssignTaken", {
      createdByUid: salesRepUid, status: "pending_dispatch", assignedRiderId: otherRiderUid,
    });
    await seedOrder("ordAssignReject", {
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
      await seedOrder(id, {
        createdByUid: salesRepUid,
        status,
        assignedRiderId: status === "pending_dispatch" ? null : riderUid,
        isLoaded: status === "loading",
        clinicName: "Lifecycle Clinic",
      });
    }
    // Assigned to somebody else — used for the wrong-rider cases.
    await seedOrder("lcOtherRider", {
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
      await seedOrder(id, {
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
    await seedOrder("fdOtherRider", {
      createdByUid: salesRepUid,
      status: "in_transit",
      assignedRiderId: otherRiderUid,
      clinicName: "Failure Clinic",
    });

    // Real staging shapes that must stay readable and must NOT be repaired
    // here: an assignment pointing at a user document that no longer exists,
    // and an order carrying only a rider name.
    await seedOrder("ordOrphanAssignment", {
      createdByUid: salesRepUid, status: "in_transit", assignedRiderId: "ghostRiderUid",
      assignedRiderName: "Ghost Rider",
    });
    await seedOrder("ordNameOnly", {
      createdByUid: salesRepUid, status: "delayed", assignedRiderName: "Name Only Rider",
    });

    // ---- Phase 02A order-snapshot fixtures ----
    // Dedicated clinics so these cases never depend on cl1, which Pclin1 mutates.
    await setDoc(doc(db, "clinics", "clVerified"), {
      name: "Verified Clinic",
      clinicId: "CLN-9123",
      location: "123 Rizal Street, Seed City",
      areaId: "seed-area",
      area: "Seed Area",
      latitude: 14.5995,
      longitude: 120.9842,
      geofenceRadiusM: 150, // deliberately NOT the 300 default
      locationVerified: true,
    });
    // Verified, but no stored radius — an order must inherit exactly 300.
    await setDoc(doc(db, "clinics", "clDefaultRadius"), {
      name: "Default Radius Clinic",
      clinicId: "CLN-0300",
      location: "456 Mabini Street, Seed City",
      areaId: "seed-area",
      area: "Seed Area",
      latitude: 10.5,
      longitude: 122.5,
      locationVerified: true,
    });
    // Real legacy shape: pinned before Phase 01, so coordinates exist but the
    // verification flag never does. Coordinates alone must not geofence.
    await setDoc(doc(db, "clinics", "clUnverified"), {
      name: "Legacy Pinned Clinic",
      clinicId: "CLN-6961",
      location: "789 Legacy Street, Seed City",
      areaId: "seed-area",
      area: "Seed Area",
      latitude: 14.5995,
      longitude: 120.9842,
    });
    // ---- Phase 02A hardening fixtures ----
    // Verified AND carrying a source timestamp, so an order's copied
    // clinicLocationUpdatedAt can be checked against the real clinic value.
    await setDoc(doc(db, "clinics", "clStamped"), {
      name: "Stamped Clinic",
      clinicId: "CLN-7777",
      location: "321 Timestamp Street, Seed City",
      areaId: "seed-area",
      area: "Seed Area",
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
      location: "500 Invalid Radius Road, Seed City",
      areaId: "seed-area",
      area: "Seed Area",
      latitude: 14.6,
      longitude: 120.99,
      geofenceRadiusM: 5000,
      locationVerified: true,
    });
    await setDoc(doc(db, "clinics", "clDecimalRadius"), {
      name: "Decimal Radius Clinic",
      clinicId: "CLN-0275",
      location: "275 Decimal Radius Road, Seed City",
      areaId: "seed-area",
      area: "Seed Area",
      latitude: 14.61,
      longitude: 120.98,
      geofenceRadiusM: 275.4,
      locationVerified: true,
    });
    await setDoc(doc(db, "clinics", "clNullRadius"), {
      name: "Null Radius Clinic",
      clinicId: "CLN-NULL",
      location: "100 Null Radius Road, Seed City",
      areaId: "seed-area",
      area: "Seed Area",
      latitude: 14.62,
      longitude: 120.97,
      geofenceRadiusM: null,
      locationVerified: true,
    });
    // An order created BEFORE Phase 02A: no snapshot fields at all. Must stay
    // readable and keep moving through its normal lifecycle.
    await seedOrder("ordLegacyNoSnapshot", {
      createdByUid: salesRepUid,
      status: "assigned",
      assignedRiderId: riderUid,
      clinicName: "Legacy Clinic",
    });
    // An order that already carries a valid snapshot — used for mutation tests.
    await seedOrder("ordWithSnapshot", {
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

    // ---- direct-write lockdown fixtures (workflow checkpoint 5) ----
    // Dedicated orders, so the lockdown cases cannot be affected by whatever
    // earlier tests did to the shared lifecycle fixtures.
    await seedOrder("lockAssigned", {
      createdByUid: salesRepUid, status: "assigned", assignedRiderId: riderUid,
    });
    await seedOrder("lockTransit", {
      createdByUid: salesRepUid, status: "in_transit", assignedRiderId: riderUid,
    });
    await seedOrder("lockDestination", {
      createdByUid: salesRepUid,
      status: "assigned",
      assignedRiderId: riderUid,
      destinationVersion: 1,
      doctorId: "doctorDestination",
      doctorName: "Dr. Ana Reyes",
      doctorAddressId: "clVerified",
      destinationType: "clinic",
      destinationName: "Verified Clinic",
      deliveryAddress: "123 Rizal Street, Seed City",
      destinationAreaId: "seed-area",
      destinationArea: "Seed Area",
      destinationLat: 14.5995,
      destinationLng: 120.9842,
      destinationGeofenceRadiusM: 150,
      destinationLocationVerified: true,
      destinationSnapshotAt: CLINIC_STAMP,
      clinicDocId: "clVerified",
      clinicId: "CLN-9123",
      clinicName: "Dr. Ana Reyes — Verified Clinic",
      clinicAddress: "123 Rizal Street, Seed City",
      clinicLat: 14.5995,
      clinicLng: 120.9842,
      clinicGeofenceRadiusM: 150,
      clinicLocationVerified: true,
      clinicLocationSnapshotAt: CLINIC_STAMP,
    });

    // ---- delivery-evidence fixtures (workflow checkpoint 4) ----
    // One order per case: a proof write is one-shot, so a successful case
    // consumes its order.
    for (const id of [
      "evTransit1", "evTransit2", "evTransit3", "evTransit4", "evTransit5",
      "evTransit6", "evTransit7", "evTransit8", "evUnicode", "evInvoice1",
      "evInvoice2", "evCombined", "evAmend",
    ]) {
      await seedOrder(id, {
        createdByUid: salesRepUid, status: "in_transit", assignedRiderId: riderUid,
      });
    }
    await seedOrder("evDelayed", {
      createdByUid: salesRepUid, status: "delayed", assignedRiderId: riderUid,
    });
    await seedOrder("evAssigned", {
      createdByUid: salesRepUid, status: "assigned", assignedRiderId: riderUid,
    });
    await seedOrder("evLoading", {
      createdByUid: salesRepUid, status: "loading", assignedRiderId: riderUid,
    });
    await seedOrder("evDelivered", {
      createdByUid: salesRepUid, status: "delivered", assignedRiderId: riderUid,
    });
    await seedOrder("evCancelled", {
      createdByUid: salesRepUid, status: "cancelled", assignedRiderId: riderUid,
    });
    await seedOrder("evFailed", {
      createdByUid: salesRepUid, status: "delivery_failed", assignedRiderId: riderUid,
      deliveryFailureReason: "Clinic closed",
    });
    // Already proven: the one-shot marker is present.
    await seedOrder("evFinalized", {
      createdByUid: salesRepUid, status: "in_transit", assignedRiderId: riderUid,
      proofOfDeliveryUrl: "https://storage/first.jpg",
      proofOfDeliveryPath: "proof_of_delivery/evFinalized/proof.jpg",
      proofRecipientName: "First Recipient",
      proofSubmittedAt: CLINIC_STAMP,
      proofSubmittedByUid: riderUid,
    });
    // Assigned to the OTHER rider, so only the assignment can refuse rider1.
    await seedOrder("evOtherRider", {
      createdByUid: salesRepUid, status: "in_transit", assignedRiderId: otherRiderUid,
    });
    // Assigned to a PENDING rider, so only their standing can refuse them.
    await seedOrder("evPendingRider", {
      createdByUid: salesRepUid, status: "in_transit", assignedRiderId: pendingRiderUid,
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

    // ---- server-priced order + its invoice (pricing checkpoint) ----
    // The invoice doc id IS the order id, which is how the rules reach the
    // order to decide whether the client may write here at all.
    await seedOrder("ordPriced", {
      createdByUid: salesRepUid,
      status: "delivered",
      allocationVersion: 1,
      pricingVersion: 1,
      priceCurrency: "PHP",
      priceIsVatInclusive: false,
      subtotalCentavos: 500000,
      items: [
        { inventoryId: "inv1", batchId: "MOD-1", name: "Moderna", quantity: 4,
          unitPriceCentavos: 125000, lineTotalCentavos: 500000, unitPrice: 1250 },
      ],
    });
    await setDoc(doc(db, "invoices", "ordPriced"), {
      orderId: "ordPriced",
      invoiceStatus: "draft",
      invoiceNumber: "INV-2026-000007",
      createdByUid: adminUid,
      createdAt: "seedPricedCreated",
      updatedAt: "seedPricedUpdated",
      pricingVersion: 1,
      invoicePricingSource: "order-snapshot",
      subtotalCentavos: 500000,
      subtotal: 5000,
      grandTotalCentavos: 560000,
      grandTotal: 5600,
      items: [
        { inventoryId: "inv1", quantity: 4, unitPriceCentavos: 125000,
          lineTotalCentavos: 500000, unitPrice: 1250 },
      ],
    });
    // A second priced order with NO invoice yet, so the CREATE path can be
    // tested (a setDoc over an existing document is an update, not a create).
    await seedOrder("ordPriced2", {
      createdByUid: salesRepUid,
      status: "delivered",
      pricingVersion: 1,
      subtotalCentavos: 125000,
      items: [
        { inventoryId: "inv9", batchId: "B-9", name: "V", quantity: 1,
          unitPriceCentavos: 125000, lineTotalCentavos: 125000, unitPrice: 1250 },
      ],
    });
    // An order with NO pricingVersion — the manual invoice path must still work
    // for it, unchanged.
    await seedOrder("ordLegacyPrice", {
      createdByUid: salesRepUid,
      status: "delivered",
      items: [{ name: "Hepatitis B", sku: "HEP-3", quantity: 5, unitPrice: 0 }],
    });
  });

  const admin = testEnv.authenticatedContext(adminUid).firestore();
  const dispatcher = testEnv.authenticatedContext(dispatcherUid).firestore();
  const salesRep = testEnv.authenticatedContext(salesRepUid).firestore();
  const rider = testEnv.authenticatedContext(riderUid).firestore();
  const pendingRider = testEnv.authenticatedContext(pendingRiderUid).firestore();
  const disabled = testEnv.authenticatedContext(disabledUid).firestore();
  const freshRider = testEnv.authenticatedContext(freshRiderUid).firestore();
  const freshSalesRep = testEnv.authenticatedContext(freshSalesRepUid).firestore();
  const freshDispatcher = testEnv.authenticatedContext(freshDispatcherUid).firestore();
  const freshAdminApplicant = testEnv.authenticatedContext(freshAdminApplicantUid).firestore();
  const anon = testEnv.unauthenticatedContext().firestore();

  console.log("\n--- POSITIVE cases ---");

  await check("P1 admin reads + writes a user doc", async () => {
    await assertSucceeds(getDoc(doc(admin, "users", riderUid)));
    await assertSucceeds(setDoc(doc(admin, "users", "tmpUserByAdmin"), { role: "salesrep", status: "pending", email: "t@x.com" }));
  });

  await check("P2 admin reads + writes an order", async () => {
    await assertSucceeds(getDoc(doc(admin, "orders", "ordSR1")));
    await assertSucceeds(setDoc(doc(admin, "orders", "tmpOrderByAdmin"), { createdByUid: salesRepUid, status: "pending_dispatch", requestedDeliveryDate: FIXTURE_DELIVERY_DATE }));
  });

  await check("P3 admin writes inventory/clinics/alerts", async () => {
    // New stock arrives through addStockBatchWithAllocation (batch + allocation
    // in one server transaction), so even a well-formed admin client create is
    // refused. The batch the later cases use is seeded as the server would.
    const invAdminData = {
      vaccineName: "Y",
      batchId: "ADM-0001",
      manufacturingDate: "2026-08-01",
      arrivalDate: "2026-09-01",
      expiryDate: "2027-12-31",
      quantity: 100,
      reservedQuantity: 0,
      sellingPriceCentavos: 125000,
    };
    await assertFails(setDoc(doc(admin, "inventory", "invAdmin"), invAdminData));
    await testEnv.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "inventory", "invAdmin"), invAdminData)
    );
    await assertSucceeds(setDoc(doc(admin, "clinics", "clAdmin"), {
      name: "C",
      areaId: "seed-area",
      area: "Seed Area",
    }));
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
      statusUpdatedAt: serverTimestamp(),
      statusUpdatedByUid: dispatcherUid,
      statusUpdatedByEmail: "d@x.com",
      updatedAt: "t",
    }));
  });

  // P7 was "sales rep creates order with own createdByUid", and it PASSED until
  // this checkpoint. It is now the negative control for the direct-write
  // lockdown: creating an order reserves stock, and a client create cannot be
  // atomic with the reservation, so the whole path moved to
  // `createOrderWithReservation`. This is a deliberate contract change.
  await check("Nlock1 a sales rep can no longer create an order directly", async () => {
    await assertFails(setDoc(doc(salesRep, "orders", "srNewOrder"), {
      createdByUid: salesRepUid,
      status: "pending_dispatch",
      clinicName: "Clinic A",
    }));
    // Not even a well-formed one with a valid clinic snapshot.
    await assertFails(setDoc(doc(salesRep, "orders", "srNewOrder2"), {
      createdByUid: salesRepUid,
      status: "pending_dispatch",
      clinicName: "Clinic A",
      allocationVersion: 1,
      allocationStatus: "reserved",
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

  await check("P11 rider updates allowed status and location fields on their own order", async () => {
    // Completing in_transit → delivered. The status audit and deliveredAt are
    // now required to be server-stamped (workflow checkpoint 2); they used to
    // be the client strings "t".
    //
    // `proofOfDeliveryUrl` USED to be part of this same write. It was removed
    // in workflow checkpoint 4, and that is a deliberate contract change, not a
    // relaxed test: proof and completion are now separate operations, and a
    // write that changes status may no longer carry evidence. Attaching proof
    // is covered by Pev1..Pev7, and the combined write it replaces is pinned as
    // a denial in Nev1.
    await assertSucceeds(updateDoc(doc(rider, "orders", "ordRider1"), {
      status: "delayed",
      delayReason: "Traffic on the bridge",
      delayedAt: serverTimestamp(),
      lastLocation: { lat: 14.5, lng: 121.0 },
      lastLocationUpdate: "t",
      locationAccuracy: 5,
      heading: 0,
      speed: 0,
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

  await check("P12b a visitor self-applies as a pending sales rep (no vehicle)", async () => {
    await assertSucceeds(setDoc(doc(freshSalesRep, "users", freshSalesRepUid), {
      role: "salesrep",
      status: "pending",
      fullName: "New Rep",
      email: "rep@x.com",
      phone: "0917",
    }));
  });

  await check("P12c a visitor self-applies as a pending dispatcher (no vehicle)", async () => {
    await assertSucceeds(setDoc(doc(freshDispatcher, "users", freshDispatcherUid), {
      role: "dispatcher",
      status: "pending",
      fullName: "New Dispatcher",
      email: "disp@x.com",
    }));
  });

  await check("Nreg-admin a visitor can NEVER self-apply as admin", async () => {
    await assertFails(setDoc(doc(freshAdminApplicant, "users", freshAdminApplicantUid), {
      role: "admin",
      status: "pending",
      fullName: "Would-be Admin",
      email: "wannabe@x.com",
    }));
  });

  await check("Nreg-approved a visitor cannot self-apply already approved (any web role)", async () => {
    for (const role of ["salesrep", "dispatcher"]) {
      await assertFails(setDoc(doc(freshSalesRep, "users", freshSalesRepUid), {
        role,
        status: "approved",
        fullName: "Self Approver",
        email: "self@x.com",
      }));
    }
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

  await check("Nreg3 a self-application must use an applicable role (never admin/unknown)", async () => {
    // Correct owner (uid == doc id) and pending status, so ONLY the role gate
    // can reject: salesrep/dispatcher/rider are the sole applicable positions,
    // and admin can never be self-applied.
    for (const role of ["admin", "superadmin", "wizard", ""]) {
      await assertFails(
        setDoc(doc(freshAdminApplicant, "users", freshAdminApplicantUid), {
          role,
          status: "pending",
          fullName: "Bad Role",
          email: "badrole@x.com",
        })
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
      routeDestinationRevision: 0,
      updatedAt: "t",
    }));
  });

  await check("P13c dispatcher writes multi-stop trip fields (ORS optimization)", async () => {
    await assertSucceeds(updateDoc(doc(dispatcher, "orders", "ordRider1"), {
      tripId: "trip-abc",
      tripStopCount: 3,
      tripPolyline: "abcde_trip_polyline",
      tripDistanceMeters: 8400,
      tripDurationSeconds: 2760,
      tripGeneratedAt: "t",
      stopSequence: 2,
      stopEtaSeconds: 900,
      stopEtaText: "3:15 PM",
      routeProvider: "openrouteservice",
      updatedAt: "t",
    }));
  });

  await check("P13a order owner and dispatcher can read server-written correction history", async () => {
    await assertSucceeds(getDoc(doc(salesRep, "orders", "ordCorrected", "destinationCorrections", "revision-1")));
    await assertSucceeds(getDoc(doc(dispatcher, "orders", "ordCorrected", "destinationCorrections", "revision-1")));
  });

  await check("P13b Med Rep owner and Dispatcher may read a server-created request", async () => {
    const path = ["orders", "ordCorrected", "destinationChangeRequests", "request-2"];
    await assertSucceeds(getDoc(doc(salesRep, ...path)));
    await assertSucceeds(getDoc(doc(dispatcher, ...path)));
    await assertFails(getDoc(doc(testEnv.authenticatedContext(otherSalesRepUid).firestore(), ...path)));
  });

  await check("N13c clients cannot submit, approve, or forge requests directly", async () => {
    const path = ["orders", "ordCorrected", "destinationChangeRequests", "request-forged"];
    await assertFails(setDoc(doc(dispatcher, ...path), { status: "pending" }));
    await assertFails(updateDoc(doc(salesRep, "orders", "ordCorrected"), {
      destinationChangeRequest: { id: "request-forged" },
    }));
    await assertFails(updateDoc(doc(admin, "orders", "ordCorrected"), {
      destinationChangeRequest: { id: "request-forged" },
    }));
    await assertFails(updateDoc(doc(salesRep, "orders", "ordCorrected", "destinationChangeRequests", "request-2"), {
      status: "approved",
    }));
  });

  await check("N13a stale route revision is refused after destination correction", async () => {
    await assertFails(updateDoc(doc(dispatcher, "orders", "ordCorrected"), {
      routePolyline: "old-route", routeGeneratedAt: "t", routeDestinationRevision: 0,
      updatedAt: "t",
    }));
    await assertSucceeds(updateDoc(doc(dispatcher, "orders", "ordCorrected"), {
      routePolyline: "new-route", routeGeneratedAt: "t", routeDestinationRevision: 1,
      updatedAt: "t",
    }));
  });

  await check("N13b no client can forge or erase destination correction audit", async () => {
    await assertFails(setDoc(doc(dispatcher, "orders", "ordCorrected", "destinationCorrections", "revision-2"), {
      revision: 2, reason: "forged",
    }));
    await assertFails(updateDoc(doc(admin, "orders", "ordCorrected"), { destinationRevision: 2 }));
    await assertFails(updateDoc(doc(salesRep, "orders", "ordCorrected"), { doctorAddressId: "clinic2" }));
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
      // A NEW manual invoice records today's convention (VAT-inclusive).
      priceIsVatInclusive: true,
      subtotal: 800,
      grandTotal: 800,
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

  await check("N11a rider cannot write multi-stop trip fields (dispatcher-only)", async () => {
    await assertFails(updateDoc(doc(rider, "orders", "ordRider1"), {
      tripId: "trip-x",
      tripPolyline: "x",
      tripGeneratedAt: "t",
      stopSequence: 1,
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
        priceIsVatInclusive: true,
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
      priceIsVatInclusive: true,
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
      priceIsVatInclusive: true,
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
      priceIsVatInclusive: true,
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
      priceIsVatInclusive: true,
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
      priceIsVatInclusive: true,
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

  // ---- area master data ----
  // Area names are immutable identities. Admins retire them with an active
  // toggle so clinics/doctors can keep a valid historical reference.

  const metroAreaId = "metro%20manila";
  const validArea = {
    key: metroAreaId,
    name: "Metro Manila",
    nameNormalized: "metro manila",
    active: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  await check("Parea1 admin creates a valid active area", async () => {
    await assertSucceeds(setDoc(doc(admin, "areas", metroAreaId), validArea));
  });

  await check("Parea2 approved roles read and query areas", async () => {
    for (const db of [admin, dispatcher, salesRep, rider]) {
      await assertSucceeds(getDoc(doc(db, "areas", metroAreaId)));
      await assertSucceeds(
        getDocs(query(collection(db, "areas"), where("active", "==", true)))
      );
    }
  });

  await check("Parea3 admin deactivates an area without renaming it", async () => {
    await assertSucceeds(updateDoc(doc(admin, "areas", metroAreaId), {
      active: false,
      updatedAt: serverTimestamp(),
    }));
  });

  await check("Narea1 non-admin roles cannot create or update areas", async () => {
    for (const db of [dispatcher, salesRep, rider]) {
      await assertFails(setDoc(doc(db, "areas", "laguna"), {
        ...validArea,
        key: "laguna",
        name: "Laguna",
        nameNormalized: "laguna",
      }));
      await assertFails(updateDoc(doc(db, "areas", metroAreaId), {
        active: true,
        updatedAt: serverTimestamp(),
      }));
    }
  });

  await check("Narea2 malformed areas and renames are rejected", async () => {
    await assertFails(setDoc(doc(admin, "areas", "cavite"), {
      ...validArea,
      key: "not-cavite",
      name: "Cavite",
      nameNormalized: "cavite",
    }));
    await assertFails(updateDoc(doc(admin, "areas", metroAreaId), {
      name: "Renamed Area",
      updatedAt: serverTimestamp(),
    }));
  });

  await check("Narea3 areas cannot be deleted or read anonymously", async () => {
    await assertFails(deleteDoc(doc(admin, "areas", metroAreaId)));
    await assertFails(getDoc(doc(anon, "areas", metroAreaId)));
  });

  // ---- doctor master data ----
  // A doctor has a stable Firestore document id and one primary organizational
  // area. Actual delivery addresses remain a separate later checkpoint.

  const doctorId = "doctor-maria-santos";
  const validDoctor = {
    name: "Dr. Maria Santos",
    nameNormalized: "dr. maria santos",
    areaId: "seed-area",
    area: "Seed Area",
    active: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  await check("Pdoctor1 admin creates a doctor under an active area", async () => {
    await assertSucceeds(setDoc(doc(admin, "doctors", doctorId), validDoctor));
  });

  await check("Pdoctor2 approved roles read and query doctors", async () => {
    for (const db of [admin, dispatcher, salesRep, rider]) {
      await assertSucceeds(getDoc(doc(db, "doctors", doctorId)));
      await assertSucceeds(
        getDocs(query(collection(db, "doctors"), where("active", "==", true)))
      );
    }
  });

  await check("Pdoctor3 admin deactivates a doctor without changing identity", async () => {
    await assertSucceeds(updateDoc(doc(admin, "doctors", doctorId), {
      active: false,
      updatedAt: serverTimestamp(),
    }));
  });

  await check("Ndoctor1 non-admin roles cannot create or update doctors", async () => {
    for (const [index, db] of [dispatcher, salesRep, rider].entries()) {
      await assertFails(
        setDoc(doc(db, "doctors", `rogue-doctor-${index}`), validDoctor)
      );
      await assertFails(updateDoc(doc(db, "doctors", doctorId), {
        active: true,
        updatedAt: serverTimestamp(),
      }));
    }
  });

  await check("Ndoctor2 malformed or inactive area relationships are rejected", async () => {
    await assertFails(setDoc(doc(admin, "doctors", "doctor-no-area"), {
      ...validDoctor,
      areaId: "missing-area",
      area: "Missing Area",
    }));
    await assertFails(setDoc(doc(admin, "doctors", "doctor-wrong-area"), {
      ...validDoctor,
      area: "Wrong Area Name",
    }));
    await assertFails(setDoc(doc(admin, "doctors", "doctor-inactive-area"), {
      ...validDoctor,
      areaId: metroAreaId,
      area: "Metro Manila",
    }));
    await assertFails(updateDoc(doc(admin, "doctors", doctorId), {
      name: "Renamed Doctor",
      updatedAt: serverTimestamp(),
    }));
  });

  await check("Ndoctor3 doctors cannot be deleted or read anonymously", async () => {
    await assertFails(deleteDoc(doc(admin, "doctors", doctorId)));
    await assertFails(getDoc(doc(anon, "doctors", doctorId)));
  });

  // ---- doctor clinic destinations ----
  // Each nested document id is a registered clinic document id. Clinic master
  // data remains authoritative for address, area, coordinates and radius.

  await assertSucceeds(updateDoc(doc(admin, "doctors", doctorId), {
    active: true,
    updatedAt: serverTimestamp(),
  }));

  const addressId = "clVerified";
  const addressRef = (db, id = addressId) =>
    doc(db, "doctors", doctorId, "deliveryAddresses", id);
  const validDoctorAddress = {
    active: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  const homeAddressRef = (db) =>
    doc(db, "doctors", doctorId, "deliveryAddresses", "home");
  const validHomeAddress = {
    kind: "home",
    addressLine: "10 Mabini Street, Seed City",
    areaId: "seed-area",
    area: "Seed Area",
    latitude: 14.5995,
    longitude: 120.9842,
    geofenceRadiusM: 300,
    active: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  await check("Paddress1 admin links a doctor to a verified registered clinic", async () => {
    await assertSucceeds(setDoc(addressRef(admin), validDoctorAddress));
  });

  await check("Paddress2 approved roles read a doctor's delivery addresses", async () => {
    for (const db of [admin, dispatcher, salesRep, rider]) {
      await assertSucceeds(getDoc(addressRef(db)));
      await assertSucceeds(
        getDocs(collection(db, "doctors", doctorId, "deliveryAddresses"))
      );
    }
  });

  await check("Paddress3 one doctor can link several different clinics", async () => {
    await assertSucceeds(
      setDoc(addressRef(admin, "clDefaultRadius"), validDoctorAddress)
    );
  });

  await check("Paddress4 admin deactivates and reactivates an address", async () => {
    await assertSucceeds(updateDoc(addressRef(admin), {
      active: false,
      updatedAt: serverTimestamp(),
    }));
    await assertSucceeds(updateDoc(addressRef(admin), {
      active: true,
      updatedAt: serverTimestamp(),
    }));
  });

  await check("NaddressHome1 malformed or duplicate Home records are rejected", async () => {
    await assertFails(setDoc(homeAddressRef(admin), {
      ...validHomeAddress,
      addressLine: "x",
    }));
    await assertFails(setDoc(homeAddressRef(admin), {
      ...validHomeAddress,
      area: "Wrong Area",
    }));
    await assertFails(setDoc(homeAddressRef(admin), {
      ...validHomeAddress,
      latitude: 91,
    }));
    await assertFails(
      setDoc(addressRef(admin, "second-home"), validHomeAddress)
    );
  });

  await check("PaddressHome1 admin creates the one reserved Home destination", async () => {
    await assertSucceeds(setDoc(homeAddressRef(admin), validHomeAddress));
  });

  await check("PaddressHome2 admin edits, deactivates and reactivates Home", async () => {
    await assertSucceeds(updateDoc(homeAddressRef(admin), {
      addressLine: "11 Mabini Street, Seed City",
      latitude: 14.6,
      updatedAt: serverTimestamp(),
    }));
    await assertSucceeds(updateDoc(homeAddressRef(admin), {
      active: false,
      updatedAt: serverTimestamp(),
    }));
    await assertSucceeds(updateDoc(homeAddressRef(admin), {
      active: true,
      updatedAt: serverTimestamp(),
    }));
  });

  await check("PaddressHome3 approved roles can read the Home destination", async () => {
    for (const db of [admin, dispatcher, salesRep, rider]) {
      await assertSucceeds(getDoc(homeAddressRef(db)));
    }
  });

  await check("NaddressHome2 Home cannot be forged, timestamp-touched or deleted", async () => {
    await assertFails(updateDoc(homeAddressRef(admin), {
      kind: "clinic",
      updatedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(homeAddressRef(admin), {
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(homeAddressRef(admin), {
      updatedAt: serverTimestamp(),
    }));
    await assertFails(deleteDoc(homeAddressRef(admin)));
  });

  await check("Naddress1 non-admin roles cannot create or update addresses", async () => {
    for (const [index, db] of [dispatcher, salesRep, rider].entries()) {
      await assertFails(
        setDoc(addressRef(db, `rogue-address-${index}`), validDoctorAddress)
      );
      await assertFails(updateDoc(addressRef(db), {
        active: false,
        updatedAt: serverTimestamp(),
      }));
      await assertFails(updateDoc(homeAddressRef(db), {
        addressLine: `Rogue Home ${index}`,
        updatedAt: serverTimestamp(),
      }));
    }
  });

  await check("Naddress2 missing, unverified or malformed clinics cannot be linked", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const clinicBase = {
        areaId: "seed-area",
        area: "Seed Area",
        latitude: 14.63,
        longitude: 120.96,
        geofenceRadiusM: 300,
        locationVerified: true,
      };
      await setDoc(doc(db, "clinics", "clBlankDetails"), {
        ...clinicBase,
        name: "   ",
        location: "     ",
      });
      await setDoc(doc(db, "clinics", "clInactiveArea"), {
        ...clinicBase,
        name: "Inactive Area Clinic",
        location: "200 Inactive Area Road",
        areaId: metroAreaId,
        area: "Metro Manila",
      });
      await setDoc(doc(db, "clinics", "clMismatchedArea"), {
        ...clinicBase,
        name: "Mismatched Area Clinic",
        location: "300 Mismatched Area Road",
        area: "Wrong Area Name",
      });
    });

    await assertFails(
      setDoc(addressRef(admin, "missing-clinic"), validDoctorAddress)
    );
    await assertFails(
      setDoc(addressRef(admin, "clUnverified"), validDoctorAddress)
    );
    await assertFails(
      setDoc(addressRef(admin, "clBadRadius"), validDoctorAddress)
    );
    await assertFails(
      setDoc(addressRef(admin, "clDecimalRadius"), validDoctorAddress)
    );
    await assertFails(
      setDoc(addressRef(admin, "clNullRadius"), validDoctorAddress)
    );
    await assertFails(
      setDoc(addressRef(admin, "clBlankDetails"), validDoctorAddress)
    );
    await assertFails(
      setDoc(addressRef(admin, "clInactiveArea"), validDoctorAddress)
    );
    await assertFails(
      setDoc(addressRef(admin, "clMismatchedArea"), validDoctorAddress)
    );
    await assertFails(setDoc(addressRef(admin, "clStamped"), {
      ...validDoctorAddress,
      clinicDocId: "forged-clinic-id",
    }));
    await assertFails(updateDoc(addressRef(admin), {
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(addressRef(admin), {
      updatedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(addressRef(admin), {
      unexpected: true,
      updatedAt: serverTimestamp(),
    }));
  });

  await check("Naddress3 malformed legacy destinations cannot be reactivated", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const malformed = {
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      };
      await setDoc(addressRef(db, "missing-clinic-inactive"), {
        ...malformed,
        active: false,
      });
      await setDoc(addressRef(db, "missing-clinic-active"), {
        ...malformed,
        active: true,
      });
    });

    await assertFails(updateDoc(addressRef(admin, "missing-clinic-inactive"), {
      active: true,
      updatedAt: serverTimestamp(),
    }));
    // A broken legacy relationship can always be made safer by deactivation.
    await assertSucceeds(updateDoc(addressRef(admin, "missing-clinic-active"), {
      active: false,
      updatedAt: serverTimestamp(),
    }));
  });

  await check("Naddress4 retired doctors block new or reactivated addresses", async () => {
    await assertSucceeds(updateDoc(doc(admin, "doctors", doctorId), {
      active: false,
      updatedAt: serverTimestamp(),
    }));
    await assertFails(
      setDoc(addressRef(admin, "clStamped"), validDoctorAddress)
    );
    // Retirement never traps an active destination: it can still be disabled.
    await assertSucceeds(updateDoc(addressRef(admin), {
      active: false,
      updatedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(addressRef(admin), {
      active: true,
      updatedAt: serverTimestamp(),
    }));
    await assertSucceeds(updateDoc(homeAddressRef(admin), {
      active: false,
      updatedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(homeAddressRef(admin), {
      active: true,
      updatedAt: serverTimestamp(),
    }));
  });

  await check("Paddress5 admin can remove only retired standalone address records", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(addressRef(db, "legacy-standalone"), {
        label: "Old Clinic Entrance",
        addressLine: "123 Retired Address Road",
        areaId: "seed-area",
        area: "Seed Area",
        latitude: 14.5,
        longitude: 120.9,
        geofenceRadiusM: 300,
        active: false,
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      });
    });

    // Registered clinic relationships remain immutable and non-deletable.
    await assertFails(deleteDoc(addressRef(admin)));
    await assertFails(deleteDoc(addressRef(dispatcher, "legacy-standalone")));
    await assertSucceeds(deleteDoc(addressRef(admin, "legacy-standalone")));
    await assertFails(getDoc(addressRef(anon)));
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

  await check("Nclin4 new clinics require one matching active area", async () => {
    await assertFails(setDoc(doc(admin, "clinics", "clNoArea"), {
      name: "No Area Clinic",
    }));
    await assertFails(setDoc(doc(admin, "clinics", "clWrongAreaName"), {
      name: "Wrong Area Clinic",
      areaId: "seed-area",
      area: "A different name",
    }));
    // Use a fresh id: the destination tests seed clInactiveArea directly.
    // Reusing it here would exercise the update rule instead of create.
    await assertFails(setDoc(doc(admin, "clinics", "clNewInactiveArea"), {
      name: "Inactive Area Clinic",
      areaId: metroAreaId,
      area: "Metro Manila",
    }));
    await assertFails(updateDoc(doc(admin, "clinics", "cl1"), {
      areaId: "seed-area",
      area: "A different name",
    }));
  });

  // ================= Phase 02A — order clinic-location snapshot =================
  //
  // The client builds the snapshot, so the rules re-derive it from the clinic
  // document. A client may choose WHICH clinic an order goes to; it may never
  // choose where that clinic is, or how large its geofence is.

  // These now run in the ADMIN context, not the sales rep's.
  //
  // A sales rep can no longer create an order from a client at all (workflow
  // checkpoint 5) — creating one reserves stock, which only the callable can do
  // atomically. Admin create survives for data repair and is still subject to
  // the same clinic-snapshot verification, so these cases keep testing exactly
  // the rule they were written for. Nsnap-series denials are unchanged in
  // meaning: a forged snapshot is refused for the creator that remains.
  const newOrder = (extra) => ({
    createdByUid: salesRepUid,
    status: "pending_dispatch",
    clinicName: "Some Clinic",
    vaccineName: "V",
    quantity: 1,
    requestedDeliveryDate: FIXTURE_DELIVERY_DATE,
    ...extra,
  });

  await check("Psnap1 admin creates an order with a faithful verified snapshot", async () => {
    await assertSucceeds(setDoc(doc(admin, "orders", "snapOk1"), newOrder({
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
    await assertSucceeds(setDoc(doc(admin, "orders", "snapOk2"), newOrder({
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
    await assertSucceeds(setDoc(doc(admin, "orders", "snapOk3"), newOrder({
      clinicDocId: "clUnverified",
      clinicId: "CLN-6961",
      clinicLocationVerified: false,
      clinicLocationSnapshotAt: serverTimestamp(),
    })));
  });

  await check("Psnap4 an order with no snapshot fields at all is still accepted", async () => {
    // Legacy shape — creation must not become impossible for callers that
    // predate the snapshot.
    await assertSucceeds(setDoc(doc(admin, "orders", "snapOk4"), newOrder({})));
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
    // The rider still takes over from in_transit: delay, then resume. Neither
    // moves stock, so neither changed.
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
    // Completing now belongs to the callable, for a legacy order too — the
    // rules do not distinguish, and the callable is what decides that a legacy
    // order settles no stock. A client `delivered` write is refused either way.
    await assertFails(updateDoc(doc(rider, "orders", "ordLegacyNoSnapshot"), {
      status: "delivered",
      deliveredAt: serverTimestamp(),
      statusUpdatedAt: serverTimestamp(),
      statusUpdatedByUid: riderUid,
      updatedAt: serverTimestamp(),
    }));
  });

  await check("Nsnap1 forged latitude is rejected", async () => {
    await assertFails(setDoc(doc(admin, "orders", "snapBad1"), newOrder({
      clinicDocId: "clVerified",
      clinicLat: 1.234, // not the clinic's
      clinicLng: 120.9842,
      clinicGeofenceRadiusM: 150,
      clinicLocationVerified: true,
    })));
  });

  await check("Nsnap2 forged longitude is rejected", async () => {
    await assertFails(setDoc(doc(admin, "orders", "snapBad2"), newOrder({
      clinicDocId: "clVerified",
      clinicLat: 14.5995,
      clinicLng: 5.678, // not the clinic's
      clinicGeofenceRadiusM: 150,
      clinicLocationVerified: true,
    })));
  });

  await check("Nsnap3 forged radius is rejected", async () => {
    await assertFails(setDoc(doc(admin, "orders", "snapBad3"), newOrder({
      clinicDocId: "clVerified",
      clinicLat: 14.5995,
      clinicLng: 120.9842,
      clinicGeofenceRadiusM: 1000, // clinic is 150
      clinicLocationVerified: true,
    })));
  });

  await check("Nsnap4 a clinicDocId that does not exist is rejected", async () => {
    await assertFails(setDoc(doc(admin, "orders", "snapBad4"), newOrder({
      clinicDocId: "clDoesNotExist",
      clinicLocationVerified: false,
    })));
  });

  await check("Nsnap5 a business clinicId that is not the clinic's own is rejected", async () => {
    await assertFails(setDoc(doc(admin, "orders", "snapBad5"), newOrder({
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
    await assertFails(setDoc(doc(admin, "orders", "snapBad6"), newOrder({
      clinicDocId: "clUnverified",
      clinicLat: 14.5995,
      clinicLng: 120.9842,
      clinicGeofenceRadiusM: 300,
      clinicLocationVerified: true,
    })));
  });

  await check("Nsnap7 an UNVERIFIED snapshot carrying coordinates is rejected", async () => {
    // "verified: false" must not become a loophole for smuggling a destination.
    await assertFails(setDoc(doc(admin, "orders", "snapBad7"), newOrder({
      clinicDocId: "clVerified",
      clinicLat: 14.5995,
      clinicLng: 120.9842,
      clinicLocationVerified: false,
    })));
  });

  await check("Nsnap8 an out-of-bounds clinic radius cannot be inherited", async () => {
    await assertFails(setDoc(doc(admin, "orders", "snapBad8"), newOrder({
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
    await assertSucceeds(setDoc(doc(admin, "orders", "snapOk7"), newOrder({
      clinicDocId: "clNoBusinessId",
      clinicLat: 13.0,
      clinicLng: 123.0,
      clinicGeofenceRadiusM: 250,
      clinicLocationVerified: true,
      clinicLocationSnapshotAt: serverTimestamp(),
    })));
  });

  await check("Psnap8 a snapshot copying the clinic's real source timestamp is accepted", async () => {
    await assertSucceeds(setDoc(doc(admin, "orders", "snapOk8"), newOrder({
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
    await assertFails(setDoc(doc(admin, "orders", "snapBad11"), newOrder({
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
    await assertFails(setDoc(doc(admin, "orders", "snapBad12"), newOrder({
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
    await assertFails(setDoc(doc(admin, "orders", "snapBad13"), newOrder({
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
    await assertFails(setDoc(doc(admin, "orders", "snapBad14"), newOrder({
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
    await assertFails(setDoc(doc(admin, "orders", "snapBad15"), newOrder({
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
    statusUpdatedAt: serverTimestamp(),
    statusUpdatedByUid: dispatcherUid,
    statusUpdatedByEmail: "dispatcher@x.com",
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
    // Delay is unchanged — it moves no stock. Completing does, so it left.
    await assertSucceeds(updateDoc(doc(rider, "orders", "ordRider1"), {
      status: "delayed",
      delayReason: "Traffic on the bridge",
      delayedAt: serverTimestamp(),
      statusUpdatedAt: serverTimestamp(),
      statusUpdatedByUid: riderUid,
      updatedAt: serverTimestamp(),
    }));
    await assertSucceeds(updateDoc(doc(rider, "orders", "ordRider1"), {
      lastLocation: { lat: 14.6, lng: 121.0 },
      lastLocationUpdate: serverTimestamp(),
      locationAccuracy: 8,
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

  // The assignment's status attribution. Without it the Assigned history event
  // had no actor and Activity kept naming the previous writer, so it is now
  // required — server-stamped, and naming the dispatcher who made the write.
  await check("Nassign-audit an assignment must carry the caller's own server-stamped status audit", async () => {
    await testEnv.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "orders", "ordAssignAudit"), {
        orderNumber: "VT-ORD-AUDIT", status: "pending_dispatch", assignedRiderId: null,
        createdByUid: salesRepUid, requestedDeliveryDate: FIXTURE_DELIVERY_DATE,
      })
    );
    const ref = doc(dispatcher, "orders", "ordAssignAudit");
    const { statusUpdatedAt, statusUpdatedByUid, statusUpdatedByEmail, ...withoutAudit } = assignment(riderUid);
    void statusUpdatedAt; void statusUpdatedByUid; void statusUpdatedByEmail;
    await assertFails(updateDoc(ref, withoutAudit));
    await assertFails(updateDoc(ref, assignment(riderUid, { statusUpdatedByUid: adminUid })));
    await assertFails(updateDoc(ref, assignment(riderUid, { statusUpdatedByUid: riderUid })));
    await assertFails(updateDoc(ref, assignment(riderUid, {
      statusUpdatedAt: Timestamp.fromDate(new Date("2026-01-01T00:00:00Z")),
    })));
    // The honest one succeeds — with or without an email.
    const { statusUpdatedByEmail: _email, ...noEmail } = assignment(riderUid);
    void _email;
    await assertSucceeds(updateDoc(ref, noEmail));
  });

  // ---------------------------------------------------------------- allocation (version 2)
  //
  // Backorder-aware orders (functions/src/allocation.js). The server computes
  // every reservation figure; a dispatcher may move an order forward only once
  // every line is fully reserved; return/quarantine counters and return
  // records are server-only.
  const allocOrder = (state, over = {}) => ({
    orderNumber: `VT-ALLOC-${state}`,
    status: "pending_dispatch",
    assignedRiderId: null,
    createdByUid: salesRepUid,
    requestedDeliveryDate: FIXTURE_DELIVERY_DATE,
    allocationVersion: 2,
    allocationStatus: "reserved",
    allocationOpen: true,
    allocationState: state,
    backorderedProductKeys: state === "fully_reserved" ? [] : ["prodA"],
    items: [{ inventoryId: "invA", productKey: "prodA", quantity: 10, reservedQuantity: state === "fully_reserved" ? 10 : 4, backorderedQuantity: state === "fully_reserved" ? 0 : 6 }],
    ...over,
  });
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const fdb = ctx.firestore();
    await setDoc(doc(fdb, "orders", "allocAwaiting"), allocOrder("awaiting_stock", { items: [{ inventoryId: "invA", productKey: "prodA", quantity: 10, reservedQuantity: 0, backorderedQuantity: 10 }] }));
    await setDoc(doc(fdb, "orders", "allocPartial"), allocOrder("partially_reserved"));
    await setDoc(doc(fdb, "orders", "allocFull"), allocOrder("fully_reserved"));
    await setDoc(doc(fdb, "orders", "allocPartialAssigned"), allocOrder("partially_reserved", { status: "assigned", assignedRiderId: riderUid }));
    await setDoc(doc(fdb, "orders", "allocPartialLoading"), allocOrder("partially_reserved", { status: "loading", assignedRiderId: riderUid, isLoaded: true }));
  });

  await check("ALLOC1 a backordered order cannot be assigned; a fully reserved one can", async () => {
    await assertFails(updateDoc(doc(dispatcher, "orders", "allocAwaiting"), assignment(riderUid)));
    await assertFails(updateDoc(doc(dispatcher, "orders", "allocPartial"), assignment(riderUid)));
    await assertSucceeds(updateDoc(doc(dispatcher, "orders", "allocFull"), assignment(riderUid)));
  });

  await check("ALLOC2 loading and dispatch are refused for an order that is not fully reserved", async () => {
    await assertFails(updateDoc(doc(dispatcher, "orders", "allocPartialAssigned"), {
      status: "loading", isLoaded: true, loadedAt: serverTimestamp(),
      statusUpdatedAt: serverTimestamp(), statusUpdatedByUid: dispatcherUid, updatedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(doc(dispatcher, "orders", "allocPartialLoading"), {
      status: "in_transit", dispatchedAt: serverTimestamp(), startedAt: serverTimestamp(),
      statusUpdatedAt: serverTimestamp(), statusUpdatedByUid: dispatcherUid, updatedAt: serverTimestamp(),
    }));
  });

  await check("ALLOC3 no client — Admin included — can forge reservation or allocation fields", async () => {
    const forged = [
      { allocationState: "fully_reserved" },
      { backorderedProductKeys: [] },
      { allocationOpen: false },
      { allocationPriorityKey: "0|2000-01-01|00:00|000000000000000|allocPartial" },
      { items: [{ inventoryId: "invA", productKey: "prodA", quantity: 10, reservedQuantity: 10, backorderedQuantity: 0 }] },
      { allocationStatus: "consumed" },
      { failureCount: 0 },
      { pendingReturnId: "x" },
      { requeuedByUid: dispatcherUid },
    ];
    for (const db of [admin, dispatcher, salesRep, rider]) {
      for (const data of forged) {
        await assertFails(updateDoc(doc(db, "orders", "allocPartial"), { ...data, updatedAt: serverTimestamp() }));
      }
    }
  });

  await check("ALLOC4 no client moves return/quarantine counters; a correction respects them", async () => {
    await testEnv.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "inventory", "invReturning"), {
        vaccineId: "prodA", vaccineName: "A", batchId: "RET-1", expiryDate: "2027-12-31",
        manufacturingDate: "2026-08-01", arrivalDate: "2026-09-01", status: "Stable",
        quantity: 20, reservedQuantity: 5, returnPendingQuantity: 3, quarantinedQuantity: 2,
        sellingPriceCentavos: 125000,
      })
    );
    for (const db of [admin, dispatcher, salesRep, rider]) {
      for (const data of [{ returnPendingQuantity: 0 }, { quarantinedQuantity: 0 }, { writtenOffQuantity: 1 }]) {
        await assertFails(updateDoc(doc(db, "inventory", "invReturning"), data));
      }
    }
    const correction = (quantity) => ({
      quantity,
      previousQuantity: 20,
      quantityCorrectedAt: serverTimestamp(),
      quantityCorrectedByUid: adminUid,
      quantityCorrectionReason: "Recount",
      updatedAt: serverTimestamp(),
    });
    // 5 reserved + 3 return-pending + 2 quarantined = 10 must stay on hand.
    await assertFails(updateDoc(doc(admin, "inventory", "invReturning"), correction(9)));
    await assertSucceeds(updateDoc(doc(admin, "inventory", "invReturning"), correction(10)));
  });

  await check("ALLOC5 return records: Admin and Dispatcher read, nobody writes", async () => {
    await testEnv.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "inventoryReturns", "ret1"), {
        orderId: "allocPartial", status: "pending", items: [{ inventoryId: "invReturning", quantity: 3 }],
        inventoryIds: ["invReturning"],
      })
    );
    await assertSucceeds(getDoc(doc(admin, "inventoryReturns", "ret1")));
    await assertSucceeds(getDoc(doc(dispatcher, "inventoryReturns", "ret1")));
    await assertFails(getDoc(doc(salesRep, "inventoryReturns", "ret1")));
    await assertFails(getDoc(doc(rider, "inventoryReturns", "ret1")));
    for (const db of [admin, dispatcher, salesRep, rider]) {
      await assertFails(updateDoc(doc(db, "inventoryReturns", "ret1"), { status: "resolved", disposition: "usable" }));
      await assertFails(setDoc(doc(db, "inventoryReturns", "forged"), { status: "pending" }));
    }
  });

  await check("ALLOC5b allocation continuations are server-only (no client reads or writes)", async () => {
    await testEnv.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "allocationContinuations", "prodA"), { productKey: "prodA", status: "pending", generation: 1 })
    );
    for (const db of [admin, dispatcher, salesRep, rider]) {
      await assertFails(getDoc(doc(db, "allocationContinuations", "prodA")));
      await assertFails(setDoc(doc(db, "allocationContinuations", "prodA"), { status: "done" }));
      await assertFails(setDoc(doc(db, "allocationContinuations", "prodB"), { status: "pending", orderCursor: "0|" }));
    }
  });

  await check("ALLOC6 a batch holding reserved, return-pending or quarantined units cannot be deleted", async () => {
    await assertFails(deleteDoc(doc(admin, "inventory", "invReturning")));
    await testEnv.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "inventory", "invEmpty"), {
        vaccineId: "prodA", batchId: "EMPTY-1", quantity: 0, reservedQuantity: 0,
        returnPendingQuantity: 0, quarantinedQuantity: 0,
      })
    );
    await assertSucceeds(deleteDoc(doc(admin, "inventory", "invEmpty")));
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

  // Plc4 was "dispatcher cancels a non-terminal order with a reason" and PASSED
  // until this checkpoint. Cancelling RELEASES reserved stock, so it moved to
  // `cancelOrderWithInventoryRelease`; every direct path is now refused, from
  // every non-terminal status. This is the negative control for that lockdown.
  await check("Nlock2 a dispatcher can no longer cancel directly", async () => {
    for (const id of ["lcPending", "lcAssigned2", "lcLoading3", "lcTransit", "lcDelayed"]) {
      await assertFails(updateDoc(doc(dispatcher, "orders", id), cancelWith("Clinic closed")));
    }
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

  // Plc7 was "rider completes from in_transit and from delayed" and PASSED until
  // this checkpoint. Completing CONSUMES reserved stock, so it moved to
  // `markOrderDeliveredWithInventoryConsumption`. Negative control for the
  // rider half of the lockdown.
  await check("Nlock3 a rider can no longer mark an order delivered directly", async () => {
    await assertFails(updateDoc(doc(rider, "orders", "lcTransit4"), complete()));
    await assertFails(updateDoc(doc(rider, "orders", "lcTransit3"), complete())); // delayed
  });

  // "Submit Proof & Complete Delivery" records both photos and then calls the
  // completion callable. Recorded evidence must not open a client path to
  // `delivered`: the callable (which consumes stock) stays the only writer.
  await check("Nlock3b complete recorded evidence still lets NO client write delivered", async () => {
    await testEnv.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "orders", "lcEvidenceReady"), {
        orderNumber: "VT-ORD-EVREADY",
        status: "in_transit",
        createdByUid: salesRepUid,
        assignedRiderId: riderUid,
        requestedDeliveryDate: FIXTURE_DELIVERY_DATE,
        proofOfDeliveryUrl: "https://storage/lcEvidenceReady/proof.jpg",
        proofOfDeliveryPath: "proof_of_delivery/lcEvidenceReady/proof.jpg",
        proofRecipientName: "Maria Santos",
        proofSubmittedAt: Timestamp.fromDate(new Date("2026-10-05T09:01:53Z")),
        proofSubmittedByUid: riderUid,
        invoiceUrl: "https://storage/lcEvidenceReady/invoice.jpg",
        invoicePath: "invoices/lcEvidenceReady/invoice.jpg",
        invoiceSubmittedAt: Timestamp.fromDate(new Date("2026-10-05T09:01:56Z")),
        invoiceSubmittedByUid: riderUid,
      })
    );
    const anon = testEnv.unauthenticatedContext().firestore();
    for (const [db, uid] of [[rider, riderUid], [dispatcher, dispatcherUid], [admin, adminUid], [salesRep, salesRepUid], [anon, null]]) {
      await assertFails(updateDoc(doc(db, "orders", "lcEvidenceReady"), {
        status: "delivered",
        deliveredAt: serverTimestamp(),
        statusUpdatedAt: serverTimestamp(),
        statusUpdatedByUid: uid,
        updatedAt: serverTimestamp(),
      }));
    }
    // ...and the stock-consumption marker cannot be forged alongside it either.
    await assertFails(updateDoc(doc(rider, "orders", "lcEvidenceReady"), {
      allocationStatus: "consumed", consumedByUid: riderUid, updatedAt: serverTimestamp(),
    }));
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
    // lcDelivered/lcCancelled are seeded terminal, and stay terminal now that
    // the rider cannot deliver lcTransit4 from a client any more.
    for (const id of ["lcDelivered", "lcCancelled"]) {
      await assertFails(updateDoc(doc(rider, "orders", id), resume()));
      await assertFails(updateDoc(doc(rider, "orders", id), delayWith("Too late")));
    }
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
  // Dispatcher: delivery_failed → pending_dispatch (requeueFailedOrder) |
  //             cancelled — both SERVER-only; no client recovery write exists.
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

  // A failure moves the reserved units to return-pending, so new Rider builds
  // report it through reportDeliveryFailure. DURING THE ROLLOUT WINDOW
  // (legacyRiderFailureWritesAllowed() == true) the old builds' direct write is
  // still accepted, in exactly the old shape — the settleClientReportedFailure
  // trigger then moves the stock. Strict mode refuses it: see "STRICT" below.
  await check("Pfd1 (compat window) an old Rider build may still mark in_transit failed directly", async () => {
    await assertSucceeds(updateDoc(doc(rider, "orders", "fdTransit"), failWith("Clinic closed")));
  });

  await check("Pfd2 (compat window) an old Rider build may still mark delayed failed directly", async () => {
    await assertSucceeds(updateDoc(doc(rider, "orders", "fdDelayed"), failWith("Address does not exist")));
  });

  await check("Pfd2b (compat window) the direct failure write can carry no stock or allocation field", async () => {
    for (const extra of [
      { failureCount: 1 }, { pendingReturnId: "x" }, { allocationState: "awaiting_stock" },
      { allocationStatus: "returned" }, { items: [] }, { backorderedProductKeys: [] },
      { allocationOpen: false }, { reservedQuantity: 0 },
    ]) {
      await assertFails(updateDoc(doc(rider, "orders", "fdTransit2"), { ...failWith("Clinic closed"), ...extra }));
    }
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

  // A failed order holds no reservation, so it cannot go straight back to a
  // rider: requeueFailedOrder returns it to the allocation queue and it is
  // assignable again only once fully reserved.
  await check("Pfd3 (now refused) a dispatcher cannot reassign a failed order directly — same rider", async () => {
    await assertFails(updateDoc(doc(dispatcher, "orders", "fdFailed"), recoverTo(riderUid)));
  });

  await check("Pfd4 (now refused) a dispatcher cannot reassign a failed order directly — other rider", async () => {
    await assertFails(updateDoc(doc(dispatcher, "orders", "fdFailed2"), recoverTo(otherRiderUid)));
  });

  await check("Nlock4 a failed order cannot be cancelled directly either", async () => {
    // Neither half of recovery is a client write any more: requeue and cancel
    // both settle stock, so both are callables.
    await assertFails(updateDoc(doc(dispatcher, "orders", "fdFailed3"), cancelWith("Clinic will not reopen")));
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

  await check("Pfd6 a failed order still reads correctly for every role", async () => {
    // fdFailed was NOT recovered by Pfd3 (refused); it stays readable as before.
    await assertSucceeds(getDoc(doc(dispatcher, "orders", "fdFailed")));
    await assertSucceeds(getDoc(doc(admin, "orders", "fdFailed")));
    await assertSucceeds(getDoc(doc(rider, "orders", "fdFailed")));
    await assertSucceeds(getDoc(doc(salesRep, "orders", "fdFailed")));
  });

  // ---- delivery evidence (workflow checkpoint 4) ----
  //
  // Proof used to be writable by any allowlisted rider write that left the
  // status alone — a bare `proofOfDeliveryUrl: "..."` was accepted, with no
  // recipient, no path check, no attribution and no limit on how many times.
  // These cases pin the replacement contract.

  const proofWrite = (extra = {}) => ({
    proofOfDeliveryUrl: "https://storage/proof.jpg",
    proofRecipientName: "Maria Santos",
    proofSubmittedAt: serverTimestamp(),
    proofSubmittedByUid: riderUid,
    updatedAt: serverTimestamp(),
    ...extra,
  });
  const invoiceWrite = (orderId, extra = {}) => ({
    invoiceUrl: "https://storage/invoice.jpg",
    invoicePath: `invoices/${orderId}/invoice.jpg`,
    invoiceSubmittedAt: serverTimestamp(),
    invoiceSubmittedByUid: riderUid,
    updatedAt: serverTimestamp(),
    ...extra,
  });

  // ---- evidence: allowed ----

  await check("Pev1 assigned rider records proof on an in_transit order", async () => {
    await assertSucceeds(updateDoc(doc(rider, "orders", "evTransit1"), proofWrite({
      proofOfDeliveryPath: "proof_of_delivery/evTransit1/proof.jpg",
    })));
  });

  await check("Pev2 assigned rider records proof on a DELAYED order", async () => {
    await assertSucceeds(updateDoc(doc(rider, "orders", "evDelayed"), proofWrite({
      proofOfDeliveryPath: "proof_of_delivery/evDelayed/proof.jpg",
    })));
  });

  await check("Pev3 proof with NO storage path is accepted (manual fallback)", async () => {
    // The debug-only manual-link fallback records a URL with no object behind
    // it. This is exactly why the path cannot yet be REQUIRED — remove the
    // fallback and this case becomes a denial.
    await assertSucceeds(updateDoc(doc(rider, "orders", "evTransit2"), proofWrite()));
  });

  await check("Pev4 a 120-unit Unicode recipient name is accepted", async () => {
    // Pins the client and the rules to the same counting unit. The Dart side
    // measures String.length (UTF-16 code units); if `size()` counted runes or
    // bytes instead, a name the app accepts would be refused here.
    const astral = "\u{1D49C}".repeat(60); // 60 astral chars = 120 UTF-16 units
    if (astral.length !== 120) throw new Error(`expected 120 units, got ${astral.length}`);
    await assertSucceeds(updateDoc(doc(rider, "orders", "evUnicode"), proofWrite({
      proofRecipientName: astral,
      proofOfDeliveryPath: "proof_of_delivery/evUnicode/proof.jpg",
    })));
  });

  await check("Pev5 the invoice photo is recorded independently of the proof", async () => {
    await assertSucceeds(updateDoc(doc(rider, "orders", "evInvoice1"), invoiceWrite("evInvoice1")));
    // And on an order whose proof is already final: finalizing one must not
    // lock the other.
    await assertSucceeds(updateDoc(doc(rider, "orders", "evFinalized"), invoiceWrite("evFinalized")));
  });

  await check("Pev6 an invoice with no storage path is accepted", async () => {
    await assertSucceeds(updateDoc(doc(rider, "orders", "evInvoice2"), {
      invoiceUrl: "https://storage/invoice.jpg",
      invoiceSubmittedAt: serverTimestamp(),
      invoiceSubmittedByUid: riderUid,
      updatedAt: serverTimestamp(),
    }));
  });

  // ---- evidence: forbidden ----

  await check("Nev1 proof cannot be attached in the same write as a status change", async () => {
    // The decisive case. Proof does not complete a delivery and completing one
    // does not require proof; allowing both in one write would have let
    // evidence in through the completion rule with none of its own checks.
    await assertFails(updateDoc(doc(rider, "orders", "evCombined"), {
      status: "delivered", deliveredAt: serverTimestamp(),
      ...audit(riderUid), ...proofWrite(),
    }));
    await assertFails(updateDoc(doc(rider, "orders", "evCombined"), {
      status: "delayed", delayReason: "Traffic", delayedAt: serverTimestamp(),
      ...audit(riderUid), proofOfDeliveryUrl: "https://storage/proof.jpg",
    }));
  });

  await check("Nev2 a bare proof URL with no recipient or attribution is rejected", async () => {
    // This is precisely what the old rules accepted.
    await assertFails(updateDoc(doc(rider, "orders", "evAmend"), {
      proofOfDeliveryUrl: "https://storage/proof.jpg",
      updatedAt: serverTimestamp(),
    }));
  });

  await check("Nev3 an amendment to a single evidence field is rejected", async () => {
    for (const payload of [
      { proofRecipientName: "Someone Else", updatedAt: serverTimestamp() },
      { proofOfDeliveryPath: "proof_of_delivery/evAmend/proof.jpg", updatedAt: serverTimestamp() },
      { proofSubmittedByUid: riderUid, updatedAt: serverTimestamp() },
      { invoiceUrl: "https://storage/i.jpg", updatedAt: serverTimestamp() },
    ]) {
      await assertFails(updateDoc(doc(rider, "orders", "evAmend"), payload));
    }
  });

  await check("Nev4 a blank, whitespace-only or oversized recipient name is rejected", async () => {
    for (const proofRecipientName of ["", "   ", "\t\n ", "a".repeat(121)]) {
      await assertFails(updateDoc(doc(rider, "orders", "evTransit3"), proofWrite({
        proofRecipientName,
        proofOfDeliveryPath: "proof_of_delivery/evTransit3/proof.jpg",
      })));
    }
  });

  await check("Nev5 a missing recipient name is rejected", async () => {
    const payload = proofWrite();
    delete payload.proofRecipientName;
    await assertFails(updateDoc(doc(rider, "orders", "evTransit3"), payload));
  });

  await check("Nev6 an empty proof URL is rejected", async () => {
    await assertFails(updateDoc(doc(rider, "orders", "evTransit3"), proofWrite({
      proofOfDeliveryUrl: "",
    })));
  });

  await check("Nev7 client-supplied timestamps are rejected", async () => {
    // proofSubmittedAt must be the SERVER's time, so the record cannot claim
    // the delivery was proven at a moment of the caller's choosing.
    await assertFails(updateDoc(doc(rider, "orders", "evTransit3"), proofWrite({
      proofSubmittedAt: new Date("2020-01-01T00:00:00Z"),
    })));
    await assertFails(updateDoc(doc(rider, "orders", "evTransit3"), proofWrite({
      updatedAt: new Date("2020-01-01T00:00:00Z"),
    })));
  });

  await check("Nev8 proof cannot be attributed to another rider", async () => {
    // Nor to an employee id, a display name or a uid fragment — none of those
    // is request.auth.uid.
    for (const uid of [otherRiderUid, "EMP-4432", "QA Rider", riderUid.slice(0, 4)]) {
      await assertFails(updateDoc(doc(rider, "orders", "evTransit3"), proofWrite({
        proofSubmittedByUid: uid,
      })));
    }
  });

  await check("Nev9 a non-canonical storage path is rejected", async () => {
    for (const proofOfDeliveryPath of [
      "proof_of_delivery/evTransit4/1788246428806.jpg", // the old timestamp name
      "proof_of_delivery/someOtherOrder/proof.jpg",     // another delivery's object
      "proof_of_delivery/evTransit4/proof.png",
      "invoices/evTransit4/proof.jpg",
      "proof.jpg",
      "",
    ]) {
      await assertFails(updateDoc(doc(rider, "orders", "evTransit4"), proofWrite({
        proofOfDeliveryPath,
      })));
    }
  });

  await check("Nev10 a second proof submission is rejected once finalized", async () => {
    await assertFails(updateDoc(doc(rider, "orders", "evFinalized"), proofWrite({
      proofOfDeliveryUrl: "https://storage/replacement.jpg",
      proofOfDeliveryPath: "proof_of_delivery/evFinalized/proof.jpg",
    })));
  });

  await check("Nev11 evidence is rejected outside in_transit and delayed", async () => {
    for (const id of ["evAssigned", "evLoading", "evDelivered", "evCancelled"]) {
      await assertFails(updateDoc(doc(rider, "orders", id), proofWrite({
        proofOfDeliveryPath: `proof_of_delivery/${id}/proof.jpg`,
      })));
      await assertFails(updateDoc(doc(rider, "orders", id), invoiceWrite(id)));
    }
  });

  // The Rider app's Proof screen offers only completable orders, and its
  // controller re-reads the order before uploading. This is the server half:
  // a stale screen still cannot attach evidence to a closed or failed order.
  await check("Nev11b a FAILED delivery accepts no new evidence either", async () => {
    await assertFails(updateDoc(doc(rider, "orders", "evFailed"), proofWrite({
      proofOfDeliveryPath: "proof_of_delivery/evFailed/proof.jpg",
    })));
    await assertFails(updateDoc(doc(rider, "orders", "evFailed"), invoiceWrite("evFailed")));
  });

  await check("Nev12 a rider cannot record proof on another rider's order", async () => {
    await assertFails(updateDoc(doc(rider, "orders", "evOtherRider"), proofWrite({
      proofOfDeliveryPath: "proof_of_delivery/evOtherRider/proof.jpg",
    })));
  });

  await check("Nev13 an unapproved rider cannot record proof on their OWN order", async () => {
    // evPendingRider IS assigned to this account, so the only thing that can
    // refuse it is their standing.
    await assertFails(updateDoc(doc(pendingRider, "orders", "evPendingRider"), proofWrite({
      proofSubmittedByUid: pendingRiderUid,
      proofOfDeliveryPath: "proof_of_delivery/evPendingRider/proof.jpg",
    })));
  });

  await check("Nev14 a sales rep cannot manufacture proof on their own order", async () => {
    // A sales rep has no field allowlist, so before this checkpoint they could
    // write a proof URL and a recipient name onto an order they raised —
    // evidence for a delivery they never made.
    await assertFails(updateDoc(doc(salesRep, "orders", "evTransit5"), proofWrite({
      proofSubmittedByUid: salesRepUid,
    })));
    await assertFails(updateDoc(doc(salesRep, "orders", "evTransit5"), {
      proofOfDeliveryUrl: "https://storage/fake.jpg", updatedAt: serverTimestamp(),
    }));
  });

  await check("Nev15 a dispatcher cannot write delivery evidence", async () => {
    await assertFails(updateDoc(doc(dispatcher, "orders", "evTransit6"), proofWrite()));
    await assertFails(updateDoc(doc(dispatcher, "orders", "evTransit6"), {
      proofOfDeliveryUrl: "https://storage/fake.jpg", updatedAt: serverTimestamp(),
    }));
  });

  await check("Nev16 an invoice path for a different order is rejected", async () => {
    await assertFails(updateDoc(doc(rider, "orders", "evTransit7"), invoiceWrite("evTransit7", {
      invoicePath: "invoices/someOtherOrder/invoice.jpg",
    })));
    await assertFails(updateDoc(doc(rider, "orders", "evTransit7"), invoiceWrite("evTransit7", {
      invoicePath: "invoices/evTransit7/1788246428806.jpg",
    })));
  });

  await check("Pev7 location tracking still works alongside the new rules", async () => {
    // The evidence branch must not have narrowed the ordinary non-status write
    // that continuous tracking depends on.
    await assertSucceeds(updateDoc(doc(rider, "orders", "evTransit8"), {
      lastLocation: { lat: 14.6, lng: 121.0 },
      lastLocationUpdate: serverTimestamp(),
      locationAccuracy: 8, heading: 90, speed: 3.4,
      updatedAt: serverTimestamp(),
    }));
  });

  // ---- direct-write lockdown (workflow checkpoint 5) ----
  //
  // Reserving, releasing and consuming stock each have to move several
  // documents together, which rules cannot express for an arbitrary number of
  // batches. Those operations moved to trusted callables running on the Admin
  // SDK — which bypasses these rules by design. What is verified here is the
  // other half: that no client SDK can reach around them.

  await check("Nlock5 no client may write an allocation field", async () => {
    const allocation = {
      allocationVersion: 1,
      allocationStatus: "released",
      updatedAt: serverTimestamp(),
    };
    for (const ctx of [admin, dispatcher, rider, salesRep]) {
      await assertFails(updateDoc(doc(ctx, "orders", "ordRider1"), allocation));
    }
    // ...nor a single one of them on its own.
    for (const field of ["allocationStatus", "reservedByUid", "consumedAt", "releasedByUid", "inventoryReconciliation"]) {
      await assertFails(updateDoc(doc(admin, "orders", "ordRider1"), {
        [field]: "x", updatedAt: serverTimestamp(),
      }));
    }
  });

  await check("Nlock6 no client may change stock counters", async () => {
    for (const ctx of [admin, dispatcher, rider, salesRep, anon]) {
      await assertFails(updateDoc(doc(ctx, "inventory", "invAdmin"), { quantity: 9999 }));
      await assertFails(updateDoc(doc(ctx, "inventory", "invAdmin"), { reservedQuantity: 5 }));
    }
    // An admin may still correct non-settlement fields.
    await assertSucceeds(updateDoc(doc(admin, "inventory", "invAdmin"), { manufacturer: "Corrected" }));
  });

  await check("Ncorr admin stock correction: only a safe, audited shape is allowed", async () => {
    // A full, valid correction. reservedQuantity is deliberately absent — it is
    // never part of a correction.
    const good = (extra) => ({
      quantity: 120,
      previousQuantity: 100,
      quantityCorrectionReason: "Recount confirms 120",
      quantityCorrectedAt: serverTimestamp(),
      quantityCorrectedByUid: adminUid,
      quantityCorrectedByEmail: "a@x.com",
      updatedAt: serverTimestamp(),
      ...extra,
    });

    // --- negatives (none commit, so invCorrect stays at 100) ---
    // below the reserved floor (reserved = 10)
    await assertFails(updateDoc(doc(admin, "inventory", "invCorrect"), good({ quantity: 5 })));
    // missing reason
    const noReason = good();
    delete noReason.quantityCorrectionReason;
    await assertFails(updateDoc(doc(admin, "inventory", "invCorrect"), noReason));
    // dishonest previousQuantity
    await assertFails(updateDoc(doc(admin, "inventory", "invCorrect"), good({ previousQuantity: 999 })));
    // client-chosen time instead of the server clock
    await assertFails(updateDoc(doc(admin, "inventory", "invCorrect"), good({ quantityCorrectedAt: new Date("2020-01-01") })));
    // actor is not the caller
    await assertFails(updateDoc(doc(admin, "inventory", "invCorrect"), good({ quantityCorrectedByUid: dispatcherUid })));
    // a correction may never move reservedQuantity
    await assertFails(updateDoc(doc(admin, "inventory", "invCorrect"), good({ reservedQuantity: 0 })));
    // nor smuggle an off-limit field alongside the correction
    await assertFails(updateDoc(doc(admin, "inventory", "invCorrect"), good({ sellingPriceCentavos: 1 })));
    // a non-admin cannot correct at all
    await assertFails(updateDoc(doc(dispatcher, "inventory", "invCorrect"), good()));

    // --- positives ---
    // down to exactly the reserved floor, on its own fixture
    await assertSucceeds(updateDoc(doc(admin, "inventory", "invCorrectFloor"), good({ quantity: 10 })));
    // a valid upward correction with full audit (runs last on invCorrect)
    await assertSucceeds(updateDoc(doc(admin, "inventory", "invCorrect"), good()));
  });

  await check("Nlock7 a new stock batch must be a valid integer batch", async () => {
    const valid = {
      vaccineName: "V", batchId: "B-1", expiryDate: "2027-12-31",
      manufacturingDate: "2026-08-01", arrivalDate: "2026-09-01",
      quantity: 10, reservedQuantity: 0, sellingPriceCentavos: 125000,
    };
    // Refused even when valid: the server callable validates and creates.
    await assertFails(setDoc(doc(admin, "inventory", "invValid"), valid));
    // The exact shapes staging already contains, and the ones a migration
    // would otherwise have to clean up later.
    for (const bad of [
      { ...valid, quantity: "10" },
      { ...valid, quantity: 1.5 },
      { ...valid, quantity: -1 },
      { ...valid, reservedQuantity: 3 },
      { ...valid, reservedQuantity: "0" },
      { ...valid, batchId: "" },
      { ...valid, expiryDate: "2027-12-3" },
    ]) {
      await assertFails(setDoc(doc(admin, "inventory", "invBad"), bad));
    }
    for (const field of ["quantity", "reservedQuantity", "sellingPriceCentavos", "batchId", "vaccineName", "expiryDate"]) {
      const missing = { ...valid };
      delete missing[field];
      await assertFails(setDoc(doc(admin, "inventory", "invMissing"), missing));
    }
  });

  await check("Nlock8 reservation and idempotency documents are invisible to clients", async () => {
    for (const ctx of [admin, dispatcher, rider, salesRep, anon]) {
      await assertFails(getDoc(doc(ctx, "inventoryReservations", "ordRider1")));
      await assertFails(setDoc(doc(ctx, "inventoryReservations", "ordRider1"), { status: "released" }));
      await assertFails(getDoc(doc(ctx, "orderRequestKeys", "k1")));
      await assertFails(setDoc(doc(ctx, "orderRequestKeys", "k1"), { orderId: "x" }));
    }
  });

  await check("Ndestination1 no client may rewrite a placed order destination", async () => {
    for (const ctx of [admin, dispatcher, rider, salesRep, anon]) {
      await assertFails(updateDoc(doc(ctx, "orders", "lockDestination"), {
        doctorId: "other-doctor",
        clinicName: "Forged destination",
        updatedAt: serverTimestamp(),
      }));
    }
  });

  await check("Ndestination2 an admin cannot fabricate a callable destination snapshot", async () => {
    await assertFails(setDoc(doc(admin, "orders", "destinationDirectCreate"), {
      status: "pending_dispatch",
      createdByUid: adminUid,
      destinationVersion: 1,
      doctorId: "doctorDestination",
      doctorName: "Dr. Ana Reyes",
      doctorAddressId: "clVerified",
      destinationType: "clinic",
      deliveryAddress: "123 Rizal Street, Seed City",
      destinationSnapshotAt: serverTimestamp(),
      // Dated, so this is refused for the forged snapshot alone.
      requestedDeliveryDate: FIXTURE_DELIVERY_DATE,
    }));
  });

  // ---------------- server-authoritative pricing ----------------
  //
  // The direct-write half of the pricing boundary. The callable decides what an
  // order costs; these prove a client SDK cannot reach around it — neither to
  // set a price on an order, nor to restate one after the fact.

  await check("Nprice1 no client may write an order pricing field", async () => {
    const pricing = {
      pricingVersion: 1,
      subtotalCentavos: 1,
      priceCurrency: "PHP",
      updatedAt: serverTimestamp(),
    };
    for (const ctx of [admin, dispatcher, rider, salesRep]) {
      await assertFails(updateDoc(doc(ctx, "orders", "ordRider1"), pricing));
    }
    // ...nor any single one of them alone. An admin quietly editing
    // `subtotalCentavos` would be restating what a clinic was charged.
    for (const field of [
      "pricingVersion", "priceCurrency", "priceIsVatInclusive",
      "subtotalCentavos", "subtotal", "pricedAt",
    ]) {
      await assertFails(updateDoc(doc(admin, "orders", "ordRider1"), {
        [field]: 1, updatedAt: serverTimestamp(),
      }));
    }
  });

  await check("Nprice2 an admin cannot create an order carrying a price", async () => {
    // Admin create survives for data repair, and must not become a way to
    // mint a priced order outside the reservation transaction.
    await assertFails(setDoc(doc(admin, "orders", "ordPriceCreate"), {
      status: "pending_dispatch",
      clinicDocId: "clinic1",
      clinicName: "Clinic One",
      pricingVersion: 1,
      subtotalCentavos: 500000,
      createdAt: serverTimestamp(),
      // Dated, so this is refused for the price fields alone.
      requestedDeliveryDate: FIXTURE_DELIVERY_DATE,
    }));
  });

  await check("Nprice3 a new stock batch must carry a valid positive price", async () => {
    const valid = {
      vaccineName: "V", batchId: "B-PRICE", expiryDate: "2027-12-31",
      manufacturingDate: "2026-08-01", arrivalDate: "2026-09-01",
      quantity: 10, reservedQuantity: 0, sellingPriceCentavos: 125000,
    };
    await assertFails(setDoc(doc(admin, "inventory", "invPriced"), valid));
    // Zero is refused as firmly as text: a batch priced at ₱0.00 would ship a
    // vaccine for free, and nothing downstream would flag it.
    for (const bad of [
      { ...valid, sellingPriceCentavos: 0 },
      { ...valid, sellingPriceCentavos: -1 },
      { ...valid, sellingPriceCentavos: "125000" },
      { ...valid, sellingPriceCentavos: 1250.5 },
      { ...valid, sellingPriceCentavos: null },
    ]) {
      await assertFails(setDoc(doc(admin, "inventory", "invBadPrice"), bad));
    }
  });

  await check("Nprice4 only an admin may re-price, and only to a valid amount", async () => {
    for (const ctx of [dispatcher, rider, salesRep, anon]) {
      await assertFails(updateDoc(doc(ctx, "inventory", "invAdmin"), {
        sellingPriceCentavos: 1,
      }));
    }
    // A VALID audit is supplied throughout, so each of these fails on the
    // amount alone rather than incidentally on the audit rule.
    const audit = { priceSetAt: serverTimestamp(), priceSetByUid: adminUid, priceIsVatInclusive: true };
    for (const bad of [0, -1, "125000", 1250.5]) {
      await assertFails(updateDoc(doc(admin, "inventory", "invAdmin"), {
        sellingPriceCentavos: bad, ...audit,
      }));
    }
    // Re-pricing must not become a back door onto the stock counters.
    await assertFails(updateDoc(doc(admin, "inventory", "invAdmin"), {
      sellingPriceCentavos: 130000, quantity: 9999, ...audit,
    }));
  });

  // ---- VAT price convention on a batch ----
  await check("Nprice-conv a re-price must stamp VAT-inclusive; the flag never flips silently", async () => {
    await testEnv.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "inventory", "invConvLegacy"), {
        vaccineName: "Legacy priced", batchId: "CONV-1", expiryDate: "2027-12-31",
        manufacturingDate: "2026-08-01", arrivalDate: "2026-09-01",
        quantity: 5, reservedQuantity: 0, sellingPriceCentavos: 100000, priceIsVatInclusive: false,
      })
    );
    const audit = { priceSetAt: serverTimestamp(), priceSetByUid: adminUid };
    // A new price that does not say it is VAT-inclusive (false, or omitted).
    await assertFails(updateDoc(doc(admin, "inventory", "invConvLegacy"), { sellingPriceCentavos: 110000, ...audit }));
    await assertFails(updateDoc(doc(admin, "inventory", "invConvLegacy"), { sellingPriceCentavos: 110000, priceIsVatInclusive: false, ...audit }));
    // Flipping the flag alone is a re-confirmation — it needs the audit.
    await assertFails(updateDoc(doc(admin, "inventory", "invConvLegacy"), { priceIsVatInclusive: true }));
    // ...and nobody but an Admin may do it.
    for (const ctx of [dispatcher, rider, salesRep]) {
      await assertFails(updateDoc(doc(ctx, "inventory", "invConvLegacy"), { priceIsVatInclusive: true, ...audit }));
    }
  });

  await check("Pprice-conv an Admin re-confirms a legacy batch's price as VAT-inclusive, audited", async () => {
    await assertSucceeds(updateDoc(doc(admin, "inventory", "invConvLegacy"), {
      sellingPriceCentavos: 100000, priceIsVatInclusive: true,
      priceSetAt: serverTimestamp(), priceSetByUid: adminUid,
    }));
    // Once VAT-inclusive, it cannot be turned back to the legacy convention.
    await assertFails(updateDoc(doc(admin, "inventory", "invConvLegacy"), {
      priceIsVatInclusive: false, priceSetAt: serverTimestamp(), priceSetByUid: adminUid,
    }));
  });

  await check("Nprice5 a re-price cannot forge its own audit trail", async () => {
    // A valid convention throughout, so each case fails on its audit alone.
    const base = { sellingPriceCentavos: 141000, priceCurrency: "PHP", priceIsVatInclusive: true };
    // No audit at all.
    await assertFails(updateDoc(doc(admin, "inventory", "invAdmin"), base));
    // A uid that is not the caller — one admin recording a re-price as another.
    await assertFails(updateDoc(doc(admin, "inventory", "invAdmin"), {
      ...base, priceSetAt: serverTimestamp(), priceSetByUid: "someone-else",
    }));
    await assertFails(updateDoc(doc(admin, "inventory", "invAdmin"), {
      ...base, priceSetAt: serverTimestamp(), priceSetByUid: null,
    }));
    // A client-chosen timestamp instead of server time.
    await assertFails(updateDoc(doc(admin, "inventory", "invAdmin"), {
      ...base, priceSetAt: new Date("2020-01-01"), priceSetByUid: adminUid,
    }));
    await assertFails(updateDoc(doc(admin, "inventory", "invAdmin"), {
      ...base, priceSetAt: "2020-01-01", priceSetByUid: adminUid,
    }));
    // Missing one half of the pair.
    await assertFails(updateDoc(doc(admin, "inventory", "invAdmin"), {
      ...base, priceSetByUid: adminUid,
    }));
    await assertFails(updateDoc(doc(admin, "inventory", "invAdmin"), {
      ...base, priceSetAt: serverTimestamp(),
    }));
  });

  await check("Pprice2 a non-price correction needs no re-price audit", async () => {
    // The audit is required only when the PRICE changes, so an unrelated fix
    // does not have to pretend to be one.
    await assertSucceeds(updateDoc(doc(admin, "inventory", "invAdmin"), {
      manufacturer: "Corrected Again",
    }));
  });

  await check("Pprice1 an admin re-prices a batch forward, with audit", async () => {
    await assertSucceeds(updateDoc(doc(admin, "inventory", "invAdmin"), {
      sellingPriceCentavos: 140000,
      priceCurrency: "PHP",
      // A price entered now is VAT-inclusive.
      priceIsVatInclusive: true,
      priceSetAt: serverTimestamp(),
      priceSetByUid: adminUid,
    }));
    // A batch that predates pricing can still be corrected on other fields —
    // the rule is guarded by presence, so it does not strand legacy stock.
    await testEnv.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "inventory", "invLegacyNoPrice"), {
        vaccineName: "Legacy", batchId: "LEG-1", expiryDate: "2027-12-31",
        manufacturingDate: "2026-08-01", arrivalDate: "2026-09-01",
        quantity: 5, reservedQuantity: 0, sellingPriceCentavos: 100,
      })
    );
    await assertSucceeds(updateDoc(doc(admin, "inventory", "invLegacyNoPrice"), {
      manufacturer: "Corrected",
    }));
  });

  // ---------------- role + authentication (checkpoint 10) ----------------

  await check("Nrole1 self-registration is confined to a pending, non-admin account", async () => {
    // The self-registration boundary. A visitor may create their OWN pending
    // account as one of the three applicable positions; admin and unknown roles
    // are refused, as is any self-approval or someone else's document.
    const fresh = testEnv.authenticatedContext("brandNewUid").firestore();
    // Admin can never be self-applied; an unknown role is refused too — even in
    // an otherwise-plausible pending shape.
    for (const role of ["admin", "wizard"]) {
      await assertFails(setDoc(doc(fresh, "users", "brandNewUid"), {
        role, status: "pending", vehicleType: "Motorcycle", email: "x@y.com",
      }));
    }
    // ...nor an APPROVED account (self-approval at creation time).
    await assertFails(setDoc(doc(fresh, "users", "brandNewUid"), {
      role: "salesrep", status: "approved", email: "x@y.com",
    }));
    // ...nor a rider without the pinned vehicle type.
    await assertFails(setDoc(doc(fresh, "users", "brandNewUid"), {
      role: "rider", status: "pending", email: "x@y.com",
    }));
    // ...nor a document belonging to someone else.
    await assertFails(setDoc(doc(fresh, "users", adminUid), {
      role: "salesrep", status: "pending", email: "x@y.com",
    }));
    // A permitted shape works (pending rider with motorcycle). The pending
    // salesrep / dispatcher shapes are covered by P12b / P12c above.
    await assertSucceeds(setDoc(doc(fresh, "users", "brandNewUid"), {
      role: "rider", status: "pending", vehicleType: "Motorcycle", email: "x@y.com",
    }));
  });

  await check("Nrole2 no user may promote or approve themselves", async () => {
    // Self-update is allowed for profile fields only; role and status must be
    // byte-identical to what is already stored.
    for (const [ctx, uid] of [[salesRep, salesRepUid], [rider, riderUid], [dispatcher, dispatcherUid]]) {
      await assertFails(updateDoc(doc(ctx, "users", uid), { role: "admin" }));
      await assertFails(updateDoc(doc(ctx, "users", uid), { status: "disabled" }));
      await assertFails(updateDoc(doc(ctx, "users", uid), { role: "admin", status: "approved" }));
      // A profile edit that leaves both alone is still fine.
      await assertSucceeds(updateDoc(doc(ctx, "users", uid), { name: "Edited Name" }));
    }

    // The case that matters most: a user who is NOT yet approved approving
    // themselves. Writing a status you already hold is a no-op, so it has to be
    // tested from an account whose status would actually CHANGE.
    await assertFails(updateDoc(doc(pendingRider, "users", pendingRiderUid), { status: "approved" }));
    await assertFails(updateDoc(doc(pendingRider, "users", pendingRiderUid), { role: "admin" }));
    await assertFails(updateDoc(doc(disabled, "users", disabledUid), { status: "approved" }));
    // ...and a pending user may still correct their own profile.
    await assertSucceeds(updateDoc(doc(pendingRider, "users", pendingRiderUid), { name: "Still Pending" }));
  });

  await check("Nrole3 an admin cannot write an unknown role or status", async () => {
    // The client validates both against an allowlist, but that lived only in
    // JavaScript. An unknown status was especially dangerous: the guards used
    // to read a missing/unknown status as approved.
    for (const role of ["wizard", "superuser", "Admin", "ADMIN", "", "rider "]) {
      await assertFails(updateDoc(doc(admin, "users", salesRepUid), { role }));
    }
    for (const status of ["active", "inactive", "Approved", "APPROVED", "", "ok"]) {
      await assertFails(updateDoc(doc(admin, "users", salesRepUid), { status }));
    }
  });

  // Fresh user records for status-transition cases (BG-001).
  const seedUser = (id, status, role = "salesrep") =>
    testEnv.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "users", id), { role, status, email: `${id}@x.com`, name: id })
    );
  const setStatus = (ctx, id, status) =>
    updateDoc(doc(ctx, "users", id), { status, updatedAt: serverTimestamp() });

  await check("Prole1 an admin may set any KNOWN role and status", async () => {
    for (const role of ["admin", "dispatcher", "salesrep", "rider"]) {
      await assertSucceeds(updateDoc(doc(admin, "users", salesRepUid), { role }));
    }
    // Every known status, each reached through a legitimate transition. This
    // used to walk ...→ rejected → disabled on one account, which is exactly
    // the BG-001 hole (a rejected application turned into another state);
    // rejected is final now, so it is reached on its own pending record. The
    // shared account still ends `disabled`, as before, for the cases below.
    for (const status of ["approved", "pending", "pending_approval", "approved", "disabled"]) {
      await assertSucceeds(updateDoc(doc(admin, "users", salesRepUid), { status }));
    }
    await seedUser("prole1Rejected", "pending");
    await assertSucceeds(updateDoc(doc(admin, "users", "prole1Rejected"), { status: "rejected" }));
  });

  await check("Nrole4 a non-admin cannot manage anyone else's role or status", async () => {
    for (const ctx of [dispatcher, salesRep, rider, anon]) {
      await assertFails(updateDoc(doc(ctx, "users", otherSalesRepUid), { role: "admin" }));
      await assertFails(updateDoc(doc(ctx, "users", otherSalesRepUid), { status: "approved" }));
      await assertFails(setDoc(doc(ctx, "users", "someoneNew"), {
        role: "admin", status: "approved",
      }));
    }
  });

  // ---------------- server-priced invoices ----------------
  //
  // Rules cannot iterate an invoice's item array, so they cannot verify that
  // every line still matches the order. Rather than write a partial check that
  // LOOKS complete, the client write is closed entirely and the callables are
  // the only way in. These cases prove that closure.

  await check("Ninv5 no client may create an invoice for a priced order", async () => {
    // `ordPriced2` is a priced order with no invoice yet, so this really is a
    // CREATE. Even a perfectly well-formed one is refused: the base pricing has
    // to be computed from the order, and a client-side create is not that.
    await assertFails(setDoc(doc(admin, "invoices", "ordPriced2"), {
      orderId: "ordPriced2", invoiceStatus: "draft", invoiceNumber: "INV-2026-000123",
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdByUid: adminUid,
    }));
  });

  await check("Ninv6 no client may edit a priced order's invoice", async () => {
    // Every one of these is the tampering the callable re-checks at issue time.
    // Rules stop them one step earlier: the write never lands.
    const attempts = [
      { items: [{ inventoryId: "inv1", quantity: 4, unitPriceCentavos: 1, lineTotalCentavos: 4 }] },
      { subtotalCentavos: 1 },
      { grandTotalCentavos: 1 },
      { grandTotal: 0.01 },
      { discountCentavos: 999999 },
      { customerName: "Renamed" },
      { invoiceStatus: "issued", issuedAt: serverTimestamp(), issuedByUid: adminUid },
    ];
    for (const patch of attempts) {
      await assertFails(updateDoc(doc(admin, "invoices", "ordPriced"), {
        ...patch, updatedAt: serverTimestamp(), updatedByUid: adminUid,
      }));
    }
    // Not even the admin, and not any other role.
    for (const ctx of [dispatcher, salesRep, rider, anon]) {
      await assertFails(updateDoc(doc(ctx, "invoices", "ordPriced"), { subtotalCentavos: 1 }));
    }
  });

  await check("Ninv7 a priced invoice stays READABLE to an admin", async () => {
    // The lockdown is on writes only — the editor still has to display it.
    await assertSucceeds(getDoc(doc(admin, "invoices", "ordPriced")));
  });

  await check("Pinv5 a LEGACY order keeps the manual invoice path", async () => {
    // No pricingVersion on the order, so the client-side create/update flow is
    // untouched — this is the workflow that must be preserved.
    await assertSucceeds(setDoc(doc(admin, "invoices", "ordLegacyPrice"), {
      orderId: "ordLegacyPrice",
      invoiceStatus: "draft",
      invoiceNumber: "INV-2026-000200",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdByUid: adminUid,
      priceIsVatInclusive: true,
      subtotal: 800,
      grandTotal: 800,
      items: [{ itemDescription: "Hepatitis B", quantity: 8, unitPrice: 100 }],
    }));
    // ...and the admin can still type a price on it.
    await assertSucceeds(updateDoc(doc(admin, "invoices", "ordLegacyPrice"), {
      items: [{ itemDescription: "Hepatitis B", quantity: 8, unitPrice: 125 }],
      subtotal: 1000,
      grandTotal: 1000,
      updatedAt: serverTimestamp(),
      updatedByUid: adminUid,
    }));
  });

  // ---- VAT price convention on a manual invoice ----
  await check("Ninv-conv a NEW manual invoice must record VAT-inclusive", async () => {
    const fresh = (id, extra) => ({
      orderId: id, invoiceStatus: "draft", invoiceNumber: "INV-2026-000300",
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdByUid: adminUid,
      subtotal: 800, grandTotal: 800, items: [{ quantity: 8, unitPrice: 100 }], ...extra,
    });
    await assertFails(setDoc(doc(admin, "invoices", "ordConvNew"), fresh("ordConvNew", {})));
    await assertFails(setDoc(doc(admin, "invoices", "ordConvNew"), fresh("ordConvNew", { priceIsVatInclusive: false })));
    await assertSucceeds(setDoc(doc(admin, "invoices", "ordConvNew"), fresh("ordConvNew", { priceIsVatInclusive: true })));
  });

  await check("Ninv-conv2 an existing manual invoice's convention can never change", async () => {
    const upd = { updatedAt: serverTimestamp(), updatedByUid: adminUid };
    // A draft saved before the flag existed (absent = VAT-exclusive).
    await testEnv.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "invoices", "ordConvOld"), {
        orderId: "ordConvOld", invoiceStatus: "draft", invoiceNumber: "INV-2026-000301",
        createdByUid: adminUid, createdAt: "seed", updatedAt: "seed",
        subtotal: 800, net: 800, vatAmount: 96, grandTotal: 896, items: [{ quantity: 8, unitPrice: 100 }],
      })
    );
    await assertFails(updateDoc(doc(admin, "invoices", "ordConvOld"), { priceIsVatInclusive: true, ...upd }));
    // The VAT-inclusive draft from the previous check cannot become legacy.
    await assertFails(updateDoc(doc(admin, "invoices", "ordConvNew"), { priceIsVatInclusive: false, ...upd }));
    await assertFails(updateDoc(doc(admin, "invoices", "ordConvNew"), { priceIsVatInclusive: null, ...upd }));
  });

  await check("Pinv-conv a legacy manual draft keeps — and may record — its VAT-exclusive convention", async () => {
    const upd = { updatedAt: serverTimestamp(), updatedByUid: adminUid };
    // Saving it again, recording the convention it already had, is allowed.
    await assertSucceeds(updateDoc(doc(admin, "invoices", "ordConvOld"), {
      priceIsVatInclusive: false, subtotal: 1000, net: 1000, vatAmount: 120, grandTotal: 1120,
      items: [{ quantity: 10, unitPrice: 100 }], ...upd,
    }));
    // It issues with its legacy figures intact.
    await assertSucceeds(updateDoc(doc(admin, "invoices", "ordConvOld"), {
      invoiceStatus: "issued", issuedAt: serverTimestamp(), issuedByUid: adminUid, ...upd,
    }));
  });

  await check("Plock1 lifecycle steps that move no stock are untouched", async () => {
    // The lockdown must not have caught assignment, loading, dispatch, delay,
    // resume, failure or route generation in its net.
    await assertSucceeds(updateDoc(doc(dispatcher, "orders", "lockAssigned"), {
      status: "loading", isLoaded: true, loadedAt: serverTimestamp(), ...audit(dispatcherUid),
    }));
    await assertSucceeds(updateDoc(doc(rider, "orders", "lockTransit"), {
      status: "delayed", delayReason: "Traffic", delayedAt: serverTimestamp(), ...audit(riderUid),
    }));
    await assertSucceeds(updateDoc(doc(rider, "orders", "lockTransit"), {
      status: "in_transit", startedAt: serverTimestamp(), ...audit(riderUid),
    }));
  });

  // ---------------- scheduled dispatch (requestedDeliveryDate) ----------------
  //
  // The emulator's request.time is the real clock, so these use dates relative
  // to Manila today. The exact 00:00 Manila boundary is pinned to the
  // millisecond in tests/dispatchEligibility.test.js against the same formula.
  console.log("\n--- scheduled dispatch ---");
  const manilaIso = (offsetDays) =>
    new Date(Date.now() + 8 * 3600000 + offsetDays * 86400000).toISOString().slice(0, 10);
  const schedToday = manilaIso(0);
  const schedYesterday = manilaIso(-1);
  const schedTomorrow = manilaIso(1);
  const schedFar = manilaIso(30);

  // Seed one pending order per case so each write starts from a known state.
  const seedSched = (id, fields) =>
    testEnv.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "orders", id), {
        createdByUid: salesRepUid,
        status: "pending_dispatch",
        assignedRiderId: null,
        ...fields,
      })
    );
  const assignPayload = () => ({
    status: "assigned",
    assignedRiderId: riderUid,
    assignedAt: serverTimestamp(),
    assignedByUid: dispatcherUid,
    statusUpdatedAt: serverTimestamp(),
    statusUpdatedByUid: dispatcherUid,
    updatedAt: serverTimestamp(),
  });

  await check("SD1 same-day and past valid dates are assignable", async () => {
    await seedSched("sdToday", { requestedDeliveryDate: schedToday });
    await seedSched("sdPast", { requestedDeliveryDate: schedYesterday });
    await assertSucceeds(updateDoc(doc(dispatcher, "orders", "sdToday"), assignPayload()));
    await assertSucceeds(updateDoc(doc(dispatcher, "orders", "sdPast"), assignPayload()));
  });

  await check("SD1b a legacy order with NO date fails closed at every dispatch step", async () => {
    // Created before the date was required. Not assignable, not loadable, not
    // finalizable, not recoverable, and a delayed one cannot resume transit.
    await seedSched("sdNone", {});
    await assertFails(updateDoc(doc(dispatcher, "orders", "sdNone"), assignPayload()));
    await assertFails(runTransaction(dispatcher, async (tx) => {
      const ref = doc(dispatcher, "orders", "sdNone");
      await tx.get(ref);
      tx.update(ref, assignPayload());
    }));

    await seedSched("sdNoneAssigned", { status: "assigned", assignedRiderId: riderUid });
    await assertFails(updateDoc(doc(dispatcher, "orders", "sdNoneAssigned"), {
      status: "loading", isLoaded: true, loadedAt: serverTimestamp(), ...audit(dispatcherUid),
    }));

    await seedSched("sdNoneLoading", { status: "loading", assignedRiderId: riderUid, isLoaded: true });
    await assertFails(updateDoc(doc(dispatcher, "orders", "sdNoneLoading"), {
      status: "in_transit", dispatchedAt: serverTimestamp(), startedAt: serverTimestamp(), ...audit(dispatcherUid),
    }));

    await seedSched("sdNoneFailed", { status: "delivery_failed", assignedRiderId: otherRiderUid });
    await assertFails(updateDoc(doc(dispatcher, "orders", "sdNoneFailed"), {
      status: "assigned",
      assignedRiderId: riderUid,
      assignedAt: serverTimestamp(),
      assignedByUid: dispatcherUid,
      reassignedAt: serverTimestamp(),
      reassignedByUid: dispatcherUid,
      previousAssignedRiderId: otherRiderUid,
      ...audit(dispatcherUid),
    }));

    await seedSched("sdNoneDelayed", { status: "delayed", assignedRiderId: riderUid });
    await assertFails(updateDoc(doc(rider, "orders", "sdNoneDelayed"), {
      status: "in_transit", startedAt: serverTimestamp(), ...audit(riderUid),
    }));
    // An admin full update cannot push it through either.
    await assertFails(updateDoc(doc(admin, "orders", "sdNone"), {
      status: "in_transit", updatedAt: serverTimestamp(),
    }));
  });

  await check("SD1c a legacy undated order keeps its non-dispatch writes", async () => {
    // Already in transit before the date was required: the rider's location
    // reporting and a delay report still work, and a dispatcher may still
    // generate a route — none of them moves the order INTO dispatch.
    await seedSched("sdNoneTransit", { status: "in_transit", assignedRiderId: riderUid });
    await assertSucceeds(updateDoc(doc(rider, "orders", "sdNoneTransit"), {
      lastLocation: { lat: 14.6, lng: 121.0 },
      lastLocationUpdate: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
    await assertSucceeds(updateDoc(doc(rider, "orders", "sdNoneTransit"), {
      status: "delayed", delayReason: "Traffic", delayedAt: serverTimestamp(), ...audit(riderUid),
    }));
  });

  await check("SD1d a legacy order becomes dispatchable once the reschedule callable stores a valid date", async () => {
    await seedSched("sdNoneRepair", {});
    await assertFails(updateDoc(doc(dispatcher, "orders", "sdNoneRepair"), assignPayload()));
    // No client stores the date directly any more — Admin included. The repair
    // path is rescheduleOrderDelivery, which also writes the schedule history.
    await assertFails(updateDoc(doc(dispatcher, "orders", "sdNoneRepair"), { requestedDeliveryDate: schedToday, updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(salesRep, "orders", "sdNoneRepair"), { requestedDeliveryDate: schedToday }));
    await assertFails(updateDoc(doc(admin, "orders", "sdNoneRepair"), { requestedDeliveryDate: "" }));
    await assertFails(updateDoc(doc(admin, "orders", "sdNoneRepair"), { requestedDeliveryDate: schedToday }));
    // What the callable writes (Admin SDK, rules bypassed):
    await testEnv.withSecurityRulesDisabled((ctx) =>
      updateDoc(doc(ctx.firestore(), "orders", "sdNoneRepair"), { requestedDeliveryDate: schedToday })
    );
    await assertSucceeds(updateDoc(doc(dispatcher, "orders", "sdNoneRepair"), assignPayload()));
  });

  await check("SD2 a future order cannot be assigned, even by a direct SDK write", async () => {
    // This is the stale-UI / modified-client path: the page is bypassed and
    // the write goes straight to Firestore.
    await seedSched("sdTomorrow", { requestedDeliveryDate: schedTomorrow });
    await seedSched("sdFar", { requestedDeliveryDate: schedFar });
    await assertFails(updateDoc(doc(dispatcher, "orders", "sdTomorrow"), assignPayload()));
    await assertFails(updateDoc(doc(dispatcher, "orders", "sdFar"), assignPayload()));
    // Through a transaction, exactly as assignRiderToOrder writes.
    await assertFails(runTransaction(dispatcher, async (tx) => {
      const ref = doc(dispatcher, "orders", "sdTomorrow");
      await tx.get(ref);
      tx.update(ref, assignPayload());
    }));
  });

  await check("SD3 missing-but-present, null, blank, malformed, impossible and legacy dates fail closed", async () => {
    const bad = {
      sdNull: null,
      sdBlank: "",
      sdSlash: "2026/10/04",
      sdShort: "2026-1-4",
      sdPadded: " 2026-10-04",
      sdImpossible: "2026-02-31",
      sdMonth13: "2026-13-01",
      sdNumber: 20261004,
      sdTimestamp: Timestamp.fromDate(new Date("2026-01-01T00:00:00Z")),
      sdMap: { y: 2026, m: 10, d: 4 },
    };
    for (const [id, value] of Object.entries(bad)) {
      await seedSched(id, { requestedDeliveryDate: value });
      await assertFails(updateDoc(doc(dispatcher, "orders", id), assignPayload()));
    }
  });

  await check("SD4 a future order already assigned cannot be loaded or dispatched", async () => {
    // Pre-existing data: assigned before this guard existed.
    await seedSched("sdAssignedFuture", {
      requestedDeliveryDate: schedTomorrow,
      status: "assigned",
      assignedRiderId: riderUid,
    });
    await assertFails(updateDoc(doc(dispatcher, "orders", "sdAssignedFuture"), {
      status: "loading", isLoaded: true, loadedAt: serverTimestamp(), ...audit(dispatcherUid),
    }));
    await seedSched("sdLoadingFuture", {
      requestedDeliveryDate: schedTomorrow,
      status: "loading",
      assignedRiderId: riderUid,
      isLoaded: true,
    });
    await assertFails(updateDoc(doc(dispatcher, "orders", "sdLoadingFuture"), {
      status: "in_transit",
      dispatchedAt: serverTimestamp(),
      startedAt: serverTimestamp(),
      ...audit(dispatcherUid),
    }));
    // ...while the same steps on a same-day order still go through.
    await seedSched("sdLoadingToday", {
      requestedDeliveryDate: schedToday,
      status: "loading",
      assignedRiderId: riderUid,
      isLoaded: true,
    });
    await assertSucceeds(updateDoc(doc(dispatcher, "orders", "sdLoadingToday"), {
      status: "in_transit",
      dispatchedAt: serverTimestamp(),
      startedAt: serverTimestamp(),
      ...audit(dispatcherUid),
    }));
  });

  await check("SD5 a failed order never returns to a rider by a client write, scheduled day or not", async () => {
    const recovery = () => ({
      status: "assigned",
      assignedRiderId: riderUid,
      assignedAt: serverTimestamp(),
      assignedByUid: dispatcherUid,
      reassignedAt: serverTimestamp(),
      reassignedByUid: dispatcherUid,
      previousAssignedRiderId: otherRiderUid,
      ...audit(dispatcherUid),
    });
    await seedSched("sdFailedFuture", {
      requestedDeliveryDate: schedTomorrow,
      status: "delivery_failed",
      assignedRiderId: otherRiderUid,
    });
    await assertFails(updateDoc(doc(dispatcher, "orders", "sdFailedFuture"), recovery()));
    await seedSched("sdFailedToday", {
      requestedDeliveryDate: schedToday,
      status: "delivery_failed",
      assignedRiderId: otherRiderUid,
    });
    // Recovery is now requeueFailedOrder's; the direct write is refused even
    // when the date has been reached.
    await assertFails(updateDoc(doc(dispatcher, "orders", "sdFailedToday"), recovery()));
  });

  await check("SD6 admin full update cannot dispatch early, or write the date directly", async () => {
    await seedSched("sdAdmin", { requestedDeliveryDate: schedTomorrow });
    await assertFails(updateDoc(doc(admin, "orders", "sdAdmin"), {
      status: "in_transit", updatedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(doc(admin, "orders", "sdAdmin"), {
      status: "assigned", assignedRiderId: riderUid, updatedAt: serverTimestamp(),
    }));
    // An admin may not write an unusable date...
    await assertFails(updateDoc(doc(admin, "orders", "sdAdmin"), { requestedDeliveryDate: "Oct 4" }));
    await assertFails(updateDoc(doc(admin, "orders", "sdAdmin"), { requestedDeliveryDate: null }));
    await assertFails(updateDoc(doc(admin, "orders", "sdAdmin"), { requestedDeliveryDate: "2026-02-31" }));
    // ...nor erase one: an undated order would only fail closed later.
    await assertFails(updateDoc(doc(admin, "orders", "sdAdmin"), { requestedDeliveryDate: deleteField() }));
    // ...and no longer writes a valid one directly either: a malformed date is
    // repaired through the rescheduleOrderDelivery callable (history included).
    await seedSched("sdAdminRepair", { requestedDeliveryDate: "2026/10/04" });
    await assertFails(updateDoc(doc(admin, "orders", "sdAdminRepair"), {
      requestedDeliveryDate: schedToday,
    }));
    await testEnv.withSecurityRulesDisabled((ctx) =>
      updateDoc(doc(ctx.firestore(), "orders", "sdAdminRepair"), { requestedDeliveryDate: schedToday })
    );
    await assertSucceeds(updateDoc(doc(dispatcher, "orders", "sdAdminRepair"), assignPayload()));
  });

  await check("SD7 admin cannot create an undated order, or one dispatched ahead of schedule", async () => {
    // Every new order needs a real date — the same requirement the callable
    // enforces, so a repair-created order cannot be born undispatchable.
    await assertFails(setDoc(doc(admin, "orders", "sdAdminCreateNone"), {
      createdByUid: salesRepUid, status: "pending_dispatch",
    }));
    await assertFails(setDoc(doc(admin, "orders", "sdAdminCreateNull"), {
      createdByUid: salesRepUid, status: "pending_dispatch", requestedDeliveryDate: null,
    }));
    await assertFails(setDoc(doc(admin, "orders", "sdAdminCreateFuture"), {
      createdByUid: salesRepUid, status: "in_transit", requestedDeliveryDate: schedTomorrow,
    }));
    await assertFails(setDoc(doc(admin, "orders", "sdAdminCreateBad"), {
      createdByUid: salesRepUid, status: "pending_dispatch", requestedDeliveryDate: "tomorrow",
    }));
    await assertSucceeds(setDoc(doc(admin, "orders", "sdAdminCreatePending"), {
      createdByUid: salesRepUid, status: "pending_dispatch", requestedDeliveryDate: schedTomorrow,
    }));
  });

  await check("SD8 nobody who runs a delivery can move the date", async () => {
    await seedSched("sdOwn", { requestedDeliveryDate: schedTomorrow });
    // The Med Rep cannot pull their own order's date forward...
    await assertFails(updateDoc(doc(salesRep, "orders", "sdOwn"), { requestedDeliveryDate: schedToday }));
    await assertFails(updateDoc(doc(salesRep, "orders", "sdOwn"), { requestedDeliveryDate: null }));
    // ...nor can the dispatcher, even folded into an assignment.
    await assertFails(updateDoc(doc(dispatcher, "orders", "sdOwn"), {
      ...assignPayload(), requestedDeliveryDate: schedToday,
    }));
  });

  await check("SD9 non-dispatch writes on an early-dispatched order are not blocked", async () => {
    // An anomaly already in transit before its date: the rider's location
    // reporting and a delay report keep working; only a move INTO dispatch
    // (here: resuming from delayed) is held until the date.
    await seedSched("sdAnomaly", {
      requestedDeliveryDate: schedTomorrow,
      status: "in_transit",
      assignedRiderId: riderUid,
    });
    await assertSucceeds(updateDoc(doc(rider, "orders", "sdAnomaly"), {
      lastLocation: { lat: 14.6, lng: 121.0 },
      lastLocationUpdate: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
    await assertSucceeds(updateDoc(doc(rider, "orders", "sdAnomaly"), {
      status: "delayed", delayReason: "Held for schedule", delayedAt: serverTimestamp(), ...audit(riderUid),
    }));
    await assertFails(updateDoc(doc(rider, "orders", "sdAnomaly"), {
      status: "in_transit", startedAt: serverTimestamp(), ...audit(riderUid),
    }));
  });

  // ---------------------------------------------------------------- delivery calendar / reschedule
  //
  // The schedule fields are server-owned: only rescheduleOrderDelivery (Admin
  // SDK) writes them, together with a scheduleEvents entry.
  await check("SCH1 no client can write any schedule field, Admin included", async () => {
    await seedSched("schFields", { requestedDeliveryDate: schedTomorrow });
    const writes = [
      { requestedDeliveryDate: schedToday },
      { scheduledDeliveryTime: "09:30" },
      { originalRequestedDeliveryDate: "2026-01-01" },
      { scheduleRevision: 1 },
      { scheduleUpdatedAt: serverTimestamp() },
      { scheduleUpdatedByUid: adminUid },
      { scheduleChangeReason: "moved" },
    ];
    for (const db of [admin, dispatcher, salesRep, rider]) {
      for (const data of writes) {
        await assertFails(updateDoc(doc(db, "orders", "schFields"), data));
      }
    }
    // Unrelated Admin edits are unaffected.
    await assertSucceeds(updateDoc(doc(admin, "orders", "schFields"), { deliveryInstructions: "Gate 2" }));
  });

  await check("SCH2 schedule history: Admin and Dispatcher read it, nobody writes it", async () => {
    await seedSched("schHist", { requestedDeliveryDate: schedTomorrow, assignedRiderId: riderUid });
    const eventPath = ["orders", "schHist", "scheduleEvents", "e1"];
    await testEnv.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), ...eventPath), { revision: 1, fromDate: schedTomorrow, toDate: schedToday, changedByUid: adminUid })
    );
    await assertSucceeds(getDoc(doc(admin, ...eventPath)));
    await assertSucceeds(getDoc(doc(dispatcher, ...eventPath)));
    // The calendar is Admin/Dispatcher only: the owning Med Rep and the
    // assigned Rider do not read schedule history.
    await assertFails(getDoc(doc(salesRep, ...eventPath)));
    await assertFails(getDoc(doc(rider, ...eventPath)));
    for (const db of [admin, dispatcher, salesRep, rider]) {
      await assertFails(setDoc(doc(db, "orders", "schHist", "scheduleEvents", "forged"), { revision: 9 }));
      await assertFails(updateDoc(doc(db, ...eventPath), { toDate: "2030-01-01" }));
      await assertFails(deleteDoc(doc(db, ...eventPath)));
    }
  });

  await check("SCH3 the Med Rep still sees their own order's current schedule", async () => {
    // A dedicated Med Rep: earlier cases change the shared sr1 account's role/status.
    await testEnv.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "users", "schRep"), { role: "salesrep", status: "approved", email: "schrep@x.com" })
    );
    await seedSched("schOwn", { requestedDeliveryDate: schedTomorrow, createdByUid: "schRep" });
    const rep = testEnv.authenticatedContext("schRep").firestore();
    const snap = await assertSucceeds(getDoc(doc(rep, "orders", "schOwn")));
    if (snap.data().requestedDeliveryDate !== schedTomorrow) throw new Error("schedule not readable");
    // ...but not another rep's order.
    await seedSched("schOther", { requestedDeliveryDate: schedTomorrow, createdByUid: "someoneElse" });
    await assertFails(getDoc(doc(rep, "orders", "schOther")));
  });

  // ---------------- BG-001: a rejected application stays rejected ----------------
  console.log("\n--- staff account status (BG-001) ---");

  await check("ACC1 admin approves or rejects a pending application", async () => {
    await seedUser("accPendA", "pending");
    await seedUser("accPendR", "pending");
    await seedUser("accPendApprovalR", "pending_approval");
    await assertSucceeds(setStatus(admin, "accPendA", "approved"));
    await assertSucceeds(setStatus(admin, "accPendR", "rejected"));
    await assertSucceeds(setStatus(admin, "accPendApprovalR", "rejected"));
  });

  await check("ACC2 a rejected application can never be activated, deactivated or reopened", async () => {
    await seedUser("accRej", "rejected");
    for (const next of ["approved", "disabled", "pending", "pending_approval"]) {
      await assertFails(setStatus(admin, "accRej", next));
    }
    // ...including a legacy capitalised value, read the way the resolver reads it.
    await seedUser("accRejLegacy", "Rejected");
    await assertFails(setStatus(admin, "accRejLegacy", "approved"));
    await seedUser("accRejSpaced", " REJECTED ");
    await assertFails(setStatus(admin, "accRejSpaced", "approved"));
  });

  await check("ACC3 only an application awaiting a decision can be rejected", async () => {
    await seedUser("accActive", "approved");
    await seedUser("accDisabled", "disabled");
    await assertFails(setStatus(admin, "accActive", "rejected"));
    await assertFails(setStatus(admin, "accDisabled", "rejected"));
  });

  await check("ACC4 deactivation and reactivation still work", async () => {
    await seedUser("accCycle", "approved");
    await assertSucceeds(setStatus(admin, "accCycle", "disabled"));
    await assertSucceeds(setStatus(admin, "accCycle", "approved"));
  });

  await check("ACC5 non-status admin edits on a rejected record are not blocked", async () => {
    await seedUser("accRejEdit", "rejected");
    await assertSucceeds(updateDoc(doc(admin, "users", "accRejEdit"), { name: "Corrected Name", updatedAt: serverTimestamp() }));
  });

  await check("ACC6 a rejected user reads only their own profile and cannot self-approve", async () => {
    await seedUser("accRejSelf", "rejected");
    const rejected = testEnv.authenticatedContext("accRejSelf").firestore();
    // Enough to show the access-denied message...
    await assertSucceeds(getDoc(doc(rejected, "users", "accRejSelf")));
    // ...and nothing else.
    await assertFails(getDoc(doc(rejected, "orders", "ordSR1")));
    await assertFails(getDoc(doc(rejected, "inventory", "inv1")));
    await assertFails(getDoc(doc(rejected, "clinics", "cl1")));
    await assertFails(setStatus(rejected, "accRejSelf", "approved"));
    await assertFails(setStatus(rejected, "accRejSelf", "pending"));
  });

  // ---------------- "My profile": a user's own record ----------------
  console.log("\n--- own profile edits ---");
  const seedProfile = (id, fields) =>
    testEnv.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "users", id), {
        email: `${id}@x.com`,
        employeeId: "EMP-0001",
        organization: "3MGS",
        department: "Sales",
        branch: "Manila",
        ...fields,
      })
    );

  await check("SELF1 every web role edits its own name and phone", async () => {
    for (const [id, role] of [["selfAdmin", "admin"], ["selfDisp", "dispatcher"], ["selfRep", "salesrep"]]) {
      await seedProfile(id, { role, status: "approved", name: "Old Name", phone: "", fullName: "Old Name", contactNumber: "" });
      const me = testEnv.authenticatedContext(id).firestore();
      await assertSucceeds(updateDoc(doc(me, "users", id), {
        name: "New Name", fullName: "New Name", phone: "+63 917 123 4567", contactNumber: "+63 917 123 4567",
        updatedAt: serverTimestamp(),
      }));
    }
  });

  await check("SELF2 a user cannot change any administrator-managed field on their own record", async () => {
    await seedProfile("selfDispatch", { role: "dispatcher", status: "approved", name: "Dispatcher" });
    const me = testEnv.authenticatedContext("selfDispatch").firestore();
    for (const [field, value] of [
      ["role", "admin"],
      ["role", "salesrep"],
      ["status", "pending"],
      ["employeeId", "EMP-9999"],
      ["email", "someone-else@x.com"],
      ["organization", "Another Org"],
      ["department", "Admin"],
      ["branch", "Cebu"],
      ["vehicleType", "Car"],
      ["anythingNew", true],
    ]) {
      await assertFails(updateDoc(doc(me, "users", "selfDispatch"), { [field]: value }));
    }
    // Not folded into an otherwise-valid name edit either.
    await assertFails(updateDoc(doc(me, "users", "selfDispatch"), { name: "Fine Name", role: "admin" }));
    // ...nor on anyone else's record.
    await seedProfile("selfOther", { role: "salesrep", status: "approved", name: "Other" });
    await assertFails(updateDoc(doc(me, "users", "selfOther"), { name: "Hijacked" }));
  });

  await check("SELF3 name and phone values are checked", async () => {
    await seedProfile("selfValues", { role: "salesrep", status: "approved", name: "Valid Name" });
    const me = testEnv.authenticatedContext("selfValues").firestore();
    await assertFails(updateDoc(doc(me, "users", "selfValues"), { name: "" }));
    await assertFails(updateDoc(doc(me, "users", "selfValues"), { name: " " }));
    await assertFails(updateDoc(doc(me, "users", "selfValues"), { name: "x".repeat(81) }));
    await assertFails(updateDoc(doc(me, "users", "selfValues"), { name: 42 }));
    await assertFails(updateDoc(doc(me, "users", "selfValues"), { phone: "1".repeat(31) }));
    await assertFails(updateDoc(doc(me, "users", "selfValues"), { name: "Fine Name", updatedAt: "yesterday" }));
    await assertSucceeds(updateDoc(doc(me, "users", "selfValues"), { phone: "" }));
  });

  await check("SELF4 only a rider writes location fields to their own record", async () => {
    await seedProfile("selfRider", { role: "rider", status: "approved", fullName: "A Rider" });
    const riderMe = testEnv.authenticatedContext("selfRider").firestore();
    await assertSucceeds(updateDoc(doc(riderMe, "users", "selfRider"), {
      lastLocation: { lat: 14.6, lng: 121.0 },
      lastLocationUpdate: serverTimestamp(),
      locationAccuracy: 5, heading: 90, speed: 1.5,
    }));
    await seedProfile("selfRepLoc", { role: "salesrep", status: "approved", name: "A Rep" });
    const repMe = testEnv.authenticatedContext("selfRepLoc").firestore();
    await assertFails(updateDoc(doc(repMe, "users", "selfRepLoc"), { lastLocation: { lat: 1, lng: 1 } }));
  });

  await check("SELF5 an administrator still manages the fields users cannot", async () => {
    await seedProfile("selfManaged", { role: "salesrep", status: "approved", name: "Managed" });
    await assertSucceeds(updateDoc(doc(admin, "users", "selfManaged"), {
      employeeId: "EMP-1234", organization: "3MGS Pharma", department: "Sales", branch: "Cebu",
    }));
  });

  // ---------------- order status history ----------------
  //
  // orders/{id}/statusEvents is written only by the recordOrderStatusEvent
  // trigger (Admin SDK). Anyone who can read the order can read its history;
  // no client can add, edit or erase an entry, or move firstDispatchedAt.
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    // Prole1 above leaves the shared sales-rep account as a disabled rider;
    // these cases need the owning sales rep back as an approved one.
    await setDoc(doc(ctx.firestore(), "users", salesRepUid), { role: "salesrep", status: "approved", email: "s@x.com" });
    await setDoc(doc(ctx.firestore(), "orders", "ordRider1", "statusEvents", "evt1"), {
      from: "loading", to: "in_transit", actorUid: dispatcherUid, riderId: riderUid, reason: null,
      at: Timestamp.fromDate(new Date("2026-10-04T02:00:00Z")), eventId: "evt1",
    });
  });
  const otherRep = testEnv.authenticatedContext(otherSalesRepUid).firestore();
  const otherRiderDb = testEnv.authenticatedContext(otherRiderUid).firestore();
  const historyDoc = (db) => doc(db, "orders", "ordRider1", "statusEvents", "evt1");

  await check("HIST1 admin, dispatcher, owning sales rep and assigned rider read an order's history", async () => {
    for (const db of [admin, dispatcher, salesRep, rider]) {
      await assertSucceeds(getDoc(historyDoc(db)));
      await assertSucceeds(getDocs(collection(db, "orders", "ordRider1", "statusEvents")));
    }
  });

  await check("HIST2 another sales rep and an unassigned rider cannot read it", async () => {
    await assertFails(getDoc(historyDoc(otherRep)));
    await assertFails(getDoc(historyDoc(otherRiderDb)));
  });

  await check("HIST3 no client — admin included — can write, edit or erase a history entry", async () => {
    for (const db of [admin, dispatcher, salesRep, rider]) {
      await assertFails(setDoc(doc(db, "orders", "ordRider1", "statusEvents", "forged"), { from: null, to: "delivered" }));
      await assertFails(updateDoc(historyDoc(db), { to: "delivered" }));
      await assertFails(deleteDoc(historyDoc(db)));
    }
  });

  await check("HIST4 no client — admin included — can set or move firstDispatchedAt", async () => {
    const stamp = Timestamp.fromDate(new Date("2026-10-01T00:00:00Z"));
    await assertFails(updateDoc(doc(admin, "orders", "ordRider1"), { firstDispatchedAt: stamp }));
    await assertFails(updateDoc(doc(dispatcher, "orders", "ordRider1"), { firstDispatchedAt: stamp }));
    await assertFails(updateDoc(doc(rider, "orders", "ordRider1"), { firstDispatchedAt: stamp }));
    // Control: the same admin write without the field is still allowed, so the
    // denial above is about firstDispatchedAt and nothing else.
    await assertSucceeds(updateDoc(doc(admin, "orders", "ordRider1"), { deliveryInstructions: "Leave at reception" }));
  });

  // The exact read the Admin Deliveries drawer makes —
  // subscribeOrderStatusEvents (src/services/statusEventService.js):
  //   query(collection(db, "orders", id, "statusEvents"), orderBy("at", "asc"))
  // On two dedicated orders, so earlier cases that move ordRider1/2 around
  // cannot change what these prove.
  //   histA: raised by sr1, assigned to rider1
  //   histB: raised by sr2, assigned to rider2
  const histQuery = (db, orderId) =>
    query(collection(db, "orders", orderId, "statusEvents"), orderBy("at", "asc"));
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const fdb = ctx.firestore();
    await setDoc(doc(fdb, "users", "histPendingDisp"), { role: "dispatcher", status: "pending" });
    await setDoc(doc(fdb, "users", "histDisabledAdmin"), { role: "admin", status: "disabled" });
    // An approved rider with no connection to histA or histB at any point.
    await setDoc(doc(fdb, "users", "histUnrelatedRider"), { role: "rider", status: "approved" });
    for (const [orderId, owner, assignee] of [
      ["histA", salesRepUid, riderUid],
      ["histB", otherSalesRepUid, otherRiderUid],
    ]) {
      await setDoc(doc(fdb, "orders", orderId), {
        orderNumber: `VT-${orderId}`, status: "delivered", createdByUid: owner,
        assignedRiderId: assignee, requestedDeliveryDate: FIXTURE_DELIVERY_DATE,
      });
      for (const [eventId, from, to, minute] of [
        ["e1", null, "pending_dispatch", 0],
        ["e2", "in_transit", "delivered", 5],
      ]) {
        await setDoc(doc(fdb, "orders", orderId, "statusEvents", eventId), {
          eventId, from, to, actorUid: to === "delivered" ? assignee : owner, riderId: assignee,
          reason: null, at: Timestamp.fromDate(new Date(`2026-10-05T02:0${minute}:00Z`)),
        });
      }
    }
  });

  await check("HIST5 Admin and Dispatcher read any order's history with the service's ordered query", async () => {
    for (const db of [admin, dispatcher]) {
      for (const orderId of ["histA", "histB"]) {
        const snap = await assertSucceeds(getDocs(histQuery(db, orderId)));
        if (snap.docs.map((d) => d.id).join() !== "e1,e2") throw new Error(`${orderId}: wrong order`);
      }
    }
  });

  await check("HIST6 the owning Med Rep and the assigned Rider read their own order's history", async () => {
    await assertSucceeds(getDocs(histQuery(salesRep, "histA")));
    await assertSucceeds(getDocs(histQuery(rider, "histA")));
    await assertSucceeds(getDocs(histQuery(otherRep, "histB")));
    await assertSucceeds(getDocs(histQuery(otherRiderDb, "histB")));
  });

  await check("HIST7 cross-order: a Med Rep or Rider cannot read another order's history", async () => {
    await assertFails(getDocs(histQuery(salesRep, "histB")));
    await assertFails(getDocs(histQuery(rider, "histB")));
    await assertFails(getDocs(histQuery(otherRep, "histA")));
    await assertFails(getDocs(histQuery(otherRiderDb, "histA")));
    await assertFails(getDoc(doc(rider, "orders", "histB", "statusEvents", "e2")));
    // Nor a collection-group sweep across every order's history.
    for (const db of [salesRep, rider]) {
      await assertFails(getDocs(collection(db, "orders", "histB", "statusEvents")));
    }
  });

  await check("HIST8 signed-out callers and unapproved staff are refused", async () => {
    const signedOut = testEnv.unauthenticatedContext().firestore();
    const pendingDisp = testEnv.authenticatedContext("histPendingDisp").firestore();
    const disabledAdmin = testEnv.authenticatedContext("histDisabledAdmin").firestore();
    for (const db of [signedOut, pendingDisp, disabledAdmin]) {
      await assertFails(getDocs(histQuery(db, "histA")));
      await assertFails(getDoc(doc(db, "orders", "histA", "statusEvents", "e1")));
    }
  });

  await check("HIST9 on reassignment the NEW rider gains the history; the previous and an unrelated rider are refused", async () => {
    const unrelatedRider = testEnv.authenticatedContext("histUnrelatedRider").firestore();
    // Before: rider1 is assigned; rider2 (assigned elsewhere) and the unrelated rider are not.
    await assertSucceeds(getDocs(histQuery(rider, "histA")));
    await assertFails(getDocs(histQuery(unrelatedRider, "histA")));

    await testEnv.withSecurityRulesDisabled((ctx) =>
      updateDoc(doc(ctx.firestore(), "orders", "histA"), { assignedRiderId: otherRiderUid })
    );
    // Newly assigned rider: allowed (query and single event).
    await assertSucceeds(getDocs(histQuery(otherRiderDb, "histA")));
    await assertSucceeds(getDoc(doc(otherRiderDb, "orders", "histA", "statusEvents", "e1")));
    // Previously assigned rider: refused.
    await assertFails(getDocs(histQuery(rider, "histA")));
    await assertFails(getDoc(doc(rider, "orders", "histA", "statusEvents", "e1")));
    // Unrelated rider: still refused.
    await assertFails(getDocs(histQuery(unrelatedRider, "histA")));
    await assertFails(getDoc(doc(unrelatedRider, "orders", "histA", "statusEvents", "e1")));

    await testEnv.withSecurityRulesDisabled((ctx) =>
      updateDoc(doc(ctx.firestore(), "orders", "histA"), { assignedRiderId: riderUid })
    );
  });

  await check("HIST10 read access grants no write: every role is refused create, edit and delete", async () => {
    const signedOut = testEnv.unauthenticatedContext().firestore();
    for (const db of [admin, dispatcher, salesRep, rider, signedOut]) {
      await assertFails(setDoc(doc(db, "orders", "histA", "statusEvents", "forged"), {
        from: "in_transit", to: "delivered", actorUid: riderUid, at: serverTimestamp(),
      }));
      await assertFails(updateDoc(doc(db, "orders", "histA", "statusEvents", "e2"), { actorUid: dispatcherUid }));
      await assertFails(deleteDoc(doc(db, "orders", "histA", "statusEvents", "e1")));
    }
  });


  // ---------------------------------------------------------------- territory
  //
  // Med Rep territory (assignedAreaIds / assignedClinicIds): Admin-only, Med
  // Rep-only, never alongside a role/status change, never self-assigned.
  const territoryWrite = (by, extra = {}) => ({
    assignedAreaIds: ["areaA"],
    assignedClinicIds: ["clinicA"],
    territoryUpdatedAt: serverTimestamp(),
    territoryUpdatedByUid: by,
    ...extra,
  });

  await check("TERR1 Admin assigns areas and clinics to a Med Rep", async () => {
    await seedProfile("terrRep1", { role: "salesrep", status: "approved", name: "Med Rep" });
    await assertSucceeds(updateDoc(doc(admin, "users", "terrRep1"), territoryWrite(adminUid)));
    // ...and can clear them again.
    await assertSucceeds(updateDoc(doc(admin, "users", "terrRep1"), territoryWrite(adminUid, { assignedAreaIds: [], assignedClinicIds: [] })));
  });

  await check("TERR2 the Med Rep can read their own assignment", async () => {
    await seedProfile("terrRep2", { role: "salesrep", status: "approved", name: "Med Rep", assignedAreaIds: ["areaA"], assignedClinicIds: [] });
    const me = testEnv.authenticatedContext("terrRep2").firestore();
    const snap = await assertSucceeds(getDoc(doc(me, "users", "terrRep2")));
    if (snap.data().assignedAreaIds[0] !== "areaA") throw new Error("assignment not readable");
  });

  await check("TERR3 no non-admin can change a territory — the Med Rep included", async () => {
    await seedProfile("terrRep3", { role: "salesrep", status: "approved", name: "Med Rep" });
    const me = testEnv.authenticatedContext("terrRep3").firestore();
    await assertFails(updateDoc(doc(me, "users", "terrRep3"), territoryWrite("terrRep3")));
    await assertFails(updateDoc(doc(me, "users", "terrRep3"), { assignedAreaIds: ["areaA"] }));
    await assertFails(updateDoc(doc(dispatcher, "users", "terrRep3"), territoryWrite(dispatcherUid)));
    await assertFails(updateDoc(doc(rider, "users", "terrRep3"), territoryWrite(riderUid)));
    await assertFails(updateDoc(doc(salesRep, "users", "terrRep3"), territoryWrite(salesRepUid)));
    // My Profile still works for the same user.
    await assertSucceeds(updateDoc(doc(me, "users", "terrRep3"), { name: "Renamed Rep", updatedAt: serverTimestamp() }));
  });

  await check("TERR4 a territory can only be put on a Med Rep account", async () => {
    await seedProfile("terrDisp", { role: "dispatcher", status: "approved", name: "Dispatcher" });
    await seedProfile("terrRider", { role: "rider", status: "approved", name: "Rider" });
    await seedProfile("terrAdmin", { role: "admin", status: "approved", name: "Admin" });
    for (const id of ["terrDisp", "terrRider", "terrAdmin"]) {
      await assertFails(updateDoc(doc(admin, "users", id), territoryWrite(adminUid)));
    }
  });

  await check("TERR5 malformed or duplicated assignments are refused", async () => {
    await seedProfile("terrRep5", { role: "salesrep", status: "approved", name: "Med Rep" });
    const ref = doc(admin, "users", "terrRep5");
    await assertFails(updateDoc(ref, territoryWrite(adminUid, { assignedAreaIds: ["areaA", "areaA"] })));
    await assertFails(updateDoc(ref, territoryWrite(adminUid, { assignedClinicIds: ["c", "c"] })));
    await assertFails(updateDoc(ref, territoryWrite(adminUid, { assignedAreaIds: "areaA" })));
    await assertFails(updateDoc(ref, territoryWrite(adminUid, { assignedAreaIds: Array.from({ length: 51 }, (_, i) => `a${i}`) })));
    await assertFails(updateDoc(ref, territoryWrite(adminUid, { territoryUpdatedByUid: "someoneElse" })));
    await assertFails(updateDoc(ref, { assignedAreaIds: ["areaA"], assignedClinicIds: [] }));
  });

  await check("TERR6 a territory write cannot carry a role or status change", async () => {
    await seedProfile("terrRep6", { role: "salesrep", status: "approved", name: "Med Rep" });
    const ref = doc(admin, "users", "terrRep6");
    await assertFails(updateDoc(ref, territoryWrite(adminUid, { role: "dispatcher" })));
    await assertFails(updateDoc(ref, territoryWrite(adminUid, { status: "disabled" })));
    // Role and status management by Admin is unchanged on its own.
    await assertSucceeds(updateDoc(ref, { status: "disabled" }));
  });

  await check("TERR7 an applicant cannot register with a territory", async () => {
    const applicant = testEnv.authenticatedContext("terrApplicant").firestore();
    await assertFails(setDoc(doc(applicant, "users", "terrApplicant"), {
      role: "salesrep", status: "pending", fullName: "New Applicant", email: "new@x.com",
      assignedAreaIds: ["areaA"], assignedClinicIds: [],
    }));
    await assertSucceeds(setDoc(doc(applicant, "users", "terrApplicant"), {
      role: "salesrep", status: "pending", fullName: "New Applicant", email: "new@x.com",
    }));
  });

  // ---------------------------------------------------------------- manufacturing date
  //
  // New batches carry a date-only manufacturingDate, on/before arrivalDate and
  // before expiryDate. Legacy batches without it keep loading and updating.
  const newBatch = (over = {}) => ({
    vaccineName: "MFG Vaccine", batchId: "MFG-0001",
    manufacturingDate: "2026-08-01", arrivalDate: "2026-09-01", expiryDate: "2027-09-01",
    quantity: 10, reservedQuantity: 0, sellingPriceCentavos: 125000,
    ...over,
  });

  // Batch creation (and its date validation) is addStockBatchWithAllocation's;
  // see functions/test/inventoryWorkflow.test.js. No client creates a batch.
  await check("MFG1 (now refused) no client creates a batch, even with valid dates", async () => {
    await assertFails(setDoc(doc(admin, "inventory", "mfgValid"), newBatch()));
    await assertFails(setDoc(doc(admin, "inventory", "mfgSameDay"), newBatch({ manufacturingDate: "2026-09-01" })));
  });

  await check("MFG2 a missing, malformed or out-of-order manufacturing date is refused", async () => {
    const missing = newBatch();
    delete missing.manufacturingDate;
    await assertFails(setDoc(doc(admin, "inventory", "mfgBad"), missing));
    const noArrival = newBatch();
    delete noArrival.arrivalDate;
    await assertFails(setDoc(doc(admin, "inventory", "mfgBad"), noArrival));
    for (const manufacturingDate of ["", "2026-8-01", "01/08/2026", "2026-13-01", "2026-08-32", 20260801, null]) {
      await assertFails(setDoc(doc(admin, "inventory", "mfgBad"), newBatch({ manufacturingDate })));
    }
    // After arrival, on expiry, after expiry.
    await assertFails(setDoc(doc(admin, "inventory", "mfgBad"), newBatch({ manufacturingDate: "2026-09-02" })));
    await assertFails(setDoc(doc(admin, "inventory", "mfgBad"), newBatch({ manufacturingDate: "2026-09-01", arrivalDate: "2026-09-01", expiryDate: "2026-09-01" })));
    await assertFails(setDoc(doc(admin, "inventory", "mfgBad"), newBatch({ manufacturingDate: "2026-08-01", arrivalDate: "2026-08-01", expiryDate: "2026-07-01" })));
  });

  await check("MFG3 non-admins still cannot create stock", async () => {
    for (const db of [dispatcher, salesRep, rider, anon]) {
      await assertFails(setDoc(doc(db, "inventory", "mfgNonAdmin"), newBatch()));
    }
  });

  await check("MFG4 legacy batches without the field stay readable and updatable", async () => {
    await testEnv.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "inventory", "mfgLegacy"), {
        vaccineName: "Legacy", batchId: "LEG-MFG", arrivalDate: "2026-01-20", expiryDate: "2027-12-31",
        quantity: 20, reservedQuantity: 0, sellingPriceCentavos: 50000,
      })
    );
    await assertSucceeds(getDoc(doc(salesRep, "inventory", "mfgLegacy")));
    await assertSucceeds(getDoc(doc(admin, "inventory", "mfgLegacy")));
    // An unrelated correction still works without the field.
    await assertSucceeds(updateDoc(doc(admin, "inventory", "mfgLegacy"), { manufacturer: "Corrected" }));
    // Adding one later is held to the same shape and order.
    await assertFails(updateDoc(doc(admin, "inventory", "mfgLegacy"), { manufacturingDate: "2026/01/01" }));
    await assertFails(updateDoc(doc(admin, "inventory", "mfgLegacy"), { manufacturingDate: "2028-01-01" }));
    await assertSucceeds(updateDoc(doc(admin, "inventory", "mfgLegacy"), { manufacturingDate: "2026-01-15" }));
  });

  await check("MFG5 a date update must leave manufacturing <= arrival < expiry", async () => {
    await testEnv.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "inventory", "mfgDates"), newBatch({ batchId: "MFG-DATES" }))
    );
    const ref = doc(admin, "inventory", "mfgDates"); // mfg 2026-08-01, arrival 2026-09-01, expiry 2027-09-01
    // 1 · arrival moved before manufacturing
    await assertFails(updateDoc(ref, { arrivalDate: "2026-07-31" }));
    // 2 · expiry on / before manufacturing
    await assertFails(updateDoc(ref, { expiryDate: "2026-08-01" }));
    await assertFails(updateDoc(ref, { expiryDate: "2026-07-01" }));
    // 3 · expiry on / before arrival (but after manufacturing)
    await assertFails(updateDoc(ref, { expiryDate: "2026-09-01" }));
    await assertFails(updateDoc(ref, { expiryDate: "2026-08-15" }));
    // a malformed or removed date is refused too
    await assertFails(updateDoc(ref, { arrivalDate: "2026-9-1" }));
    await assertFails(updateDoc(ref, { arrivalDate: deleteField() }));
    // 4 · a valid coordinated update is accepted
    await assertSucceeds(updateDoc(ref, { manufacturingDate: "2026-07-01", arrivalDate: "2026-07-15", expiryDate: "2027-07-15" }));
    await assertSucceeds(updateDoc(ref, { arrivalDate: "2026-07-01" })); // equal to manufacturing is allowed
  });

  await check("MFG6 a legacy batch without manufacturingDate: unrelated updates pass, date edits need one", async () => {
    await testEnv.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "inventory", "mfgLegacy2"), {
        vaccineName: "Legacy", batchId: "LEG-MFG-2", arrivalDate: "2026-01-20", expiryDate: "2027-12-31",
        quantity: 20, reservedQuantity: 0, sellingPriceCentavos: 50000,
      })
    );
    const ref = doc(admin, "inventory", "mfgLegacy2");
    // 5 · an unrelated permitted update is unaffected by the missing field
    await assertSucceeds(updateDoc(ref, { manufacturer: "Corrected Manufacturer" }));
    // 6 · editing a date without supplying a manufacturing date is refused
    await assertFails(updateDoc(ref, { expiryDate: "2027-11-30" }));
    await assertFails(updateDoc(ref, { arrivalDate: "2026-01-25" }));
    // 7 · editing the dates while adding a valid manufacturing date is accepted
    await assertSucceeds(updateDoc(ref, { manufacturingDate: "2026-01-10", expiryDate: "2027-11-30" }));
  });

  await check("MFG7 date updates stay Admin-only", async () => {
    await testEnv.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "inventory", "mfgNonAdminUpd"), newBatch({ batchId: "MFG-NA" }))
    );
    // 8 · every non-admin is refused, even with a fully valid date set
    const valid = { manufacturingDate: "2026-07-01", arrivalDate: "2026-07-15", expiryDate: "2027-07-15" };
    for (const db of [dispatcher, salesRep, rider, anon]) {
      await assertFails(updateDoc(doc(db, "inventory", "mfgNonAdminUpd"), valid));
      await assertFails(updateDoc(doc(db, "inventory", "mfgNonAdminUpd"), { manufacturer: "X" }));
    }
  });

  await check("MFG8 date checks leave the quantity/reservation guards unchanged", async () => {
    const ref = doc(admin, "inventory", "mfgDates");
    // A valid date edit cannot smuggle a reserved or on-hand change through.
    await assertFails(updateDoc(ref, { expiryDate: "2027-08-15", reservedQuantity: 5 }));
    await assertFails(updateDoc(ref, { expiryDate: "2027-08-15", quantity: 9999 }));
    await assertSucceeds(updateDoc(ref, { expiryDate: "2027-08-15" }));
  });

  // ---------------------------------------------------------------- VAT classification
  //
  // Vaccine products carry vatClassification ('vatable' | 'vat_exempt'); order
  // items carry an immutable snapshot of it.
  const vaccine = (over = {}) => ({
    vaccineName: "VAT Vaccine", manufacturer: "Maker", vaccineType: "Influenza",
    internalSku: "VXT-111-AAAAA", vatClassification: "vatable", ...over,
  });

  await check("VAT1 a new vaccine needs a valid classification", async () => {
    await assertSucceeds(setDoc(doc(admin, "vaccines", "vatV1"), vaccine()));
    await assertSucceeds(setDoc(doc(admin, "vaccines", "vatV2"), vaccine({ vatClassification: "vat_exempt" })));
    const missing = vaccine();
    delete missing.vatClassification;
    await assertFails(setDoc(doc(admin, "vaccines", "vatBad"), missing));
    for (const vatClassification of ["VAT", "zero_rated", "", null, true]) {
      await assertFails(setDoc(doc(admin, "vaccines", "vatBad"), vaccine({ vatClassification })));
    }
  });

  await check("VAT2 Admin classifies a legacy product with a recorded who/when", async () => {
    await testEnv.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "vaccines", "vatLegacy"), { vaccineName: "Legacy", internalSku: "VXT-222-BBBBB" })
    );
    const ref = doc(admin, "vaccines", "vatLegacy");
    // Legacy stays readable and editable on other fields.
    await assertSucceeds(getDoc(doc(salesRep, "vaccines", "vatLegacy")));
    await assertSucceeds(updateDoc(ref, { manufacturer: "Corrected" }));
    // Classifying must be valid and stamped by the session.
    await assertFails(updateDoc(ref, { vatClassification: "vatable" }));
    await assertFails(updateDoc(ref, { vatClassification: "zero_rated", vatClassificationSetAt: serverTimestamp(), vatClassificationSetByUid: adminUid }));
    await assertFails(updateDoc(ref, { vatClassification: "vatable", vatClassificationSetAt: serverTimestamp(), vatClassificationSetByUid: "someoneElse" }));
    await assertSucceeds(updateDoc(ref, { vatClassification: "vatable", vatClassificationSetAt: serverTimestamp(), vatClassificationSetByUid: adminUid }));
    // Re-classifying is allowed on the same terms; removing it is not.
    await assertSucceeds(updateDoc(ref, { vatClassification: "vat_exempt", vatClassificationSetAt: serverTimestamp(), vatClassificationSetByUid: adminUid }));
    await assertFails(updateDoc(ref, { vatClassification: deleteField(), vatClassificationSetAt: serverTimestamp(), vatClassificationSetByUid: adminUid }));
  });

  await check("VAT3 no non-admin can create or change a vaccine classification", async () => {
    for (const db of [dispatcher, salesRep, rider, anon]) {
      await assertFails(setDoc(doc(db, "vaccines", "vatNonAdmin"), vaccine()));
      await assertFails(updateDoc(doc(db, "vaccines", "vatV1"), {
        vatClassification: "vat_exempt", vatClassificationSetAt: serverTimestamp(), vatClassificationSetByUid: "x",
      }));
    }
  });

  await check("VAT4 order items (price and VAT snapshots) cannot be rewritten by any client", async () => {
    await testEnv.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "orders", "ordVat"), {
        createdByUid: salesRepUid, status: "pending_dispatch", assignedRiderId: null,
        items: [{ inventoryId: "b1", quantity: 1, unitPriceCentavos: 1000, lineTotalCentavos: 1000, vatClassification: "vatable" }],
      })
    );
    const forged = [{ inventoryId: "b1", quantity: 1, unitPriceCentavos: 1000, lineTotalCentavos: 1000, vatClassification: "vat_exempt" }];
    for (const db of [admin, dispatcher, salesRep, rider]) {
      await assertFails(updateDoc(doc(db, "orders", "ordVat"), { items: forged }));
    }
    // Historical reads are unaffected, and unrelated Admin edits still work.
    await assertSucceeds(getDoc(doc(salesRep, "orders", "ordVat")));
    await assertSucceeds(updateDoc(doc(admin, "orders", "ordVat"), { deliveryInstructions: "Leave at reception" }));
  });

  // ---------------------------------------------------------------- order history
  //
  // Order Confirmation Receipts + Stock Allocation History: Admin reads all; a
  // Med Rep reads only what the server recorded as theirs; Dispatcher and
  // Rider have no access; no client role writes, edits or deletes an entry.
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const f = ctx.firestore();
    const receipt = (orderId, medRepUid) => ({
      receiptType: "order_confirmation", receiptKind: "original", isReconstructed: false,
      orderId, orderNumber: `VT-ORD-${orderId}`, medRepUid, priority: "Standard",
      lines: [{ lineIndex: 0, productKey: "vacP", sku: "ATV-001", quantityRequested: 3, unitPriceCentavos: 125000 }],
      skus: ["ATV-001"], subtotalCentavos: 375000, createdAt: Timestamp.fromDate(new Date("2026-10-05T02:00:00Z")),
    });
    const event = (orderId, medRepUid) => ({
      eventType: "stock_allocated", orderId, medRepUid, quantityChanged: 1, batchIds: ["BT-3131-3131"],
      createdAt: Timestamp.fromDate(new Date("2026-10-05T02:00:01Z")), ordinal: 0,
    });
    await setDoc(doc(f, "orderReceipts", "ordSR1"), receipt("ordSR1", salesRepUid));
    await setDoc(doc(f, "orderReceipts", "ordOtherRep"), receipt("ordOtherRep", otherSalesRepUid));
    await setDoc(doc(f, "inventoryAllocationEvents", "ordSR1__e0__alloc__vacP__r1"), event("ordSR1", salesRepUid));
    await setDoc(doc(f, "inventoryAllocationEvents", "ordOtherRep__e0__alloc__vacP__r1"), event("ordOtherRep", otherSalesRepUid));
  });
  {
    const otherRepDb = testEnv.authenticatedContext(otherSalesRepUid).firestore();
    const ownEventId = "ordSR1__e0__alloc__vacP__r1";
    const otherEventId = "ordOtherRep__e0__alloc__vacP__r1";

    await check("ORH1 admin reads every receipt and every allocation event", async () => {
      await assertSucceeds(getDoc(doc(admin, "orderReceipts", "ordSR1")));
      await assertSucceeds(getDoc(doc(admin, "orderReceipts", "ordOtherRep")));
      await assertSucceeds(getDocs(query(collection(admin, "orderReceipts"), orderBy("createdAt", "desc"))));
      await assertSucceeds(getDocs(query(collection(admin, "orderReceipts"), where("skus", "array-contains", "ATV-001"))));
      await assertSucceeds(getDoc(doc(admin, "inventoryAllocationEvents", otherEventId)));
      await assertSucceeds(getDocs(query(collection(admin, "inventoryAllocationEvents"), where("orderId", "==", "ordOtherRep"))));
      await assertSucceeds(getDocs(query(collection(admin, "inventoryAllocationEvents"), where("batchIds", "array-contains", "BT-3131-3131"))));
    });

    await check("ORH2 a Med Rep reads their own receipts and allocation history", async () => {
      await assertSucceeds(getDoc(doc(salesRep, "orderReceipts", "ordSR1")));
      await assertSucceeds(getDocs(query(collection(salesRep, "orderReceipts"), where("medRepUid", "==", salesRepUid))));
      await assertSucceeds(getDocs(query(
        collection(salesRep, "orderReceipts"),
        where("medRepUid", "==", salesRepUid),
        where("orderId", "in", ["ordSR1", "ordOtherRep"])
      )));
      await assertSucceeds(getDoc(doc(salesRep, "inventoryAllocationEvents", ownEventId)));
      await assertSucceeds(getDocs(query(
        collection(salesRep, "inventoryAllocationEvents"),
        where("medRepUid", "==", salesRepUid),
        where("orderId", "==", "ordSR1")
      )));
    });

    await check("ORH3 a Med Rep cannot read another Med Rep's receipts or history", async () => {
      await assertFails(getDoc(doc(salesRep, "orderReceipts", "ordOtherRep")));
      await assertFails(getDoc(doc(salesRep, "inventoryAllocationEvents", otherEventId)));
      await assertFails(getDoc(doc(otherRepDb, "orderReceipts", "ordSR1")));
      // A query must be scoped to the caller; an unscoped or foreign one is refused.
      await assertFails(getDocs(collection(salesRep, "orderReceipts")));
      await assertFails(getDocs(query(collection(salesRep, "orderReceipts"), where("medRepUid", "==", otherSalesRepUid))));
      await assertFails(getDocs(query(collection(salesRep, "inventoryAllocationEvents"), where("orderId", "==", "ordOtherRep"))));
    });

    await check("ORH4 Dispatcher, Rider, unapproved and signed-out users have no access", async () => {
      for (const db of [dispatcher, rider, pendingRider, disabled, anon]) {
        await assertFails(getDoc(doc(db, "orderReceipts", "ordSR1")));
        await assertFails(getDocs(collection(db, "orderReceipts")));
        await assertFails(getDoc(doc(db, "inventoryAllocationEvents", ownEventId)));
        await assertFails(getDocs(collection(db, "inventoryAllocationEvents")));
      }
    });

    await check("ORH5 no client role can create, edit or delete a receipt or an allocation event", async () => {
      for (const db of [admin, salesRep, dispatcher, rider]) {
        await assertFails(setDoc(doc(db, "orderReceipts", "forged"), { orderId: "forged", medRepUid: salesRepUid }));
        await assertFails(updateDoc(doc(db, "orderReceipts", "ordSR1"), { subtotalCentavos: 1 }));
        await assertFails(setDoc(doc(db, "orderReceipts", "ordSR1"), { orderId: "ordSR1", medRepUid: salesRepUid }));
        await assertFails(deleteDoc(doc(db, "orderReceipts", "ordSR1")));
        await assertFails(setDoc(doc(db, "inventoryAllocationEvents", "forged"), { orderId: "ordSR1", medRepUid: salesRepUid }));
        await assertFails(updateDoc(doc(db, "inventoryAllocationEvents", ownEventId), { quantityChanged: 99 }));
        await assertFails(deleteDoc(doc(db, "inventoryAllocationEvents", ownEventId)));
      }
    });

    await check("ORH6 an order's owner and reference are fixed — not even Admin can redirect them", async () => {
      await assertFails(updateDoc(doc(admin, "orders", "ordSR1"), { createdByUid: otherSalesRepUid }));
      await assertFails(updateDoc(doc(admin, "orders", "ordSR1"), { orderNumber: "VT-ORD-FORGED" }));
      await assertFails(updateDoc(doc(admin, "orders", "ordSR1"), { createdByRole: "admin" }));
      // An ordinary Admin edit is unaffected.
      await assertSucceeds(updateDoc(doc(admin, "orders", "ordSR1"), { deliveryInstructions: "Gate 2", updatedAt: serverTimestamp() }));
    });

    await check("ORH7 the history outbox is server-only: no client reads or writes it", async () => {
      await testEnv.withSecurityRulesDisabled((ctx) =>
        setDoc(doc(ctx.firestore(), "orderHistoryOutbox", "ordSR1"), { status: "pending", orderId: "ordSR1", medRepUid: salesRepUid })
      );
      for (const db of [admin, salesRep, dispatcher, rider, anon]) {
        await assertFails(getDoc(doc(db, "orderHistoryOutbox", "ordSR1")));
        await assertFails(getDocs(collection(db, "orderHistoryOutbox")));
        await assertFails(setDoc(doc(db, "orderHistoryOutbox", "forged"), { status: "done" }));
        await assertFails(updateDoc(doc(db, "orderHistoryOutbox", "ordSR1"), { status: "done" }));
        await assertFails(deleteDoc(doc(db, "orderHistoryOutbox", "ordSR1")));
      }
    });

    await check("ORH8 the history pages' exact query shapes: scoped for a Med Rep, bounded for Admin", async () => {
      const since = Timestamp.fromDate(new Date("2026-01-01T00:00:00Z"));
      // Med Rep: paging and exact-reference lookup carry the ownership filter.
      await assertSucceeds(getDocs(query(collection(salesRep, "orders"),
        where("createdByUid", "==", salesRepUid), where("createdAt", ">=", since), orderBy("createdAt", "desc"), limit(25))));
      await assertSucceeds(getDocs(query(collection(salesRep, "orders"),
        where("createdByUid", "==", salesRepUid), where("orderNumber", "==", "VT-ORD-ordSR1"), limit(10))));
      await assertSucceeds(getDocs(query(collection(salesRep, "inventoryAllocationEvents"),
        where("medRepUid", "==", salesRepUid), where("orderId", "==", "ordSR1"), orderBy("createdAt", "asc"), limit(500))));
      // ...and without it, or aimed at another Med Rep, the same shapes are refused.
      await assertFails(getDocs(query(collection(salesRep, "orders"), where("orderNumber", "==", "VT-ORD-ordSR2"), limit(10))));
      await assertFails(getDocs(query(collection(salesRep, "orders"), orderBy("createdAt", "desc"), limit(25))));
      await assertFails(getDocs(query(collection(salesRep, "orderReceipts"), where("orderId", "in", ["ordSR1"]))));
      // Admin: the whole history, page by page.
      await assertSucceeds(getDocs(query(collection(admin, "orders"), orderBy("createdAt", "desc"), limit(25))));
      await assertSucceeds(getDocs(query(collection(admin, "orders"), where("orderNumber", "==", "VT-ORD-ordSR2"), limit(10))));
      await assertSucceeds(getDocs(query(collection(admin, "orderReceipts"), where("orderId", "in", ["ordSR1", "ordOtherRep"]))));
    });
  }

  // ---------------------------------------------------------------- STRICT (phase 2)
  //
  // The same rules with legacyRiderFailureWritesAllowed() → false: what is
  // deployed once every active Rider runs a build that uses the callable. Only
  // the compatibility window differs; everything else is the file above.
  {
    const COMPAT = "function legacyRiderFailureWritesAllowed() {\n      return true;\n    }";
    const shipped = readFileSync("firestore.rules", "utf8").replace(/\r\n/g, "\n");
    if (!shipped.includes(COMPAT)) throw new Error("the compatibility switch must be present and set to true");
    if (shipped.split("legacyRiderFailureWritesAllowed()").length - 1 !== 2) throw new Error("the switch must be defined once and used once");
    const strictRules = shipped.replace(COMPAT, COMPAT.replace("return true;", "return false;"));
    const strictEnv = await initializeTestEnvironment({
      projectId: `${PROJECT_ID}-strict`,
      firestore: { rules: strictRules, host: "127.0.0.1", port: EMULATOR_PORT },
    });
    const strictRider = strictEnv.authenticatedContext(riderUid).firestore();
    await strictEnv.withSecurityRulesDisabled(async (ctx) => {
      const fdb = ctx.firestore();
      await setDoc(doc(fdb, "users", riderUid), { role: "rider", status: "approved", fullName: "R" });
      for (const [id, status] of [["stTransit", "in_transit"], ["stDelayed", "delayed"]]) {
        await setDoc(doc(fdb, "orders", id), {
          orderNumber: id, status, assignedRiderId: riderUid, createdByUid: salesRepUid,
          requestedDeliveryDate: FIXTURE_DELIVERY_DATE,
        });
      }
    });
    await check("STRICT1 phase-2 rules refuse every direct failure write", async () => {
      await assertFails(updateDoc(doc(strictRider, "orders", "stTransit"), failWith("Clinic closed")));
      await assertFails(updateDoc(doc(strictRider, "orders", "stDelayed"), failWith("Clinic closed")));
    });
    await check("STRICT2 phase-2 rules still allow the rider's other lifecycle writes", async () => {
      await assertSucceeds(updateDoc(doc(strictRider, "orders", "stTransit"), {
        status: "delayed", delayReason: "Traffic", delayedAt: serverTimestamp(), ...audit(riderUid),
      }));
    });
    await strictEnv.cleanup();
  }

  // ---------------- AI inventory analytics (Phase 1) ----------------
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const f = ctx.firestore();
    await setDoc(doc(f, "vaccines", "vacAnalytics"), { vaccineName: "Analytics Vaccine", internalSku: "ANA-001" });
    await setDoc(doc(f, "inventoryForecasts", "vacAnalytics__all__30d"), {
      vaccineId: "vacAnalytics", horizonDays: 30, predictedDemandQuantity: 120, advisoryOnly: true, runId: "run1",
    });
    await setDoc(doc(f, "inventoryAnalyticsRuns", "run1"), { runId: "run1", forecastCount: 3, advisoryOnly: true });
    await setDoc(doc(f, "inventoryAnalyticsConfig", "vacAnalytics"), {
      vaccineId: "vacAnalytics", leadTimeDays: 14, safetyStockDays: null, safetyStockQuantity: 20,
      enabled: true, updatedAt: Timestamp.fromDate(new Date("2026-10-01T00:00:00Z")), updatedByUid: adminUid,
    });
  });
  const analyticsConfig = (over = {}) => ({
    vaccineId: "vacAnalytics", leadTimeDays: 21, safetyStockDays: null, safetyStockQuantity: 50,
    enabled: true, updatedAt: serverTimestamp(), updatedByUid: adminUid, ...over,
  });

  await check("PAN1 an Admin reads forecasts, analytics runs and configuration", async () => {
    await assertSucceeds(getDoc(doc(admin, "inventoryForecasts", "vacAnalytics__all__30d")));
    await assertSucceeds(getDocs(collection(admin, "inventoryForecasts")));
    await assertSucceeds(getDoc(doc(admin, "inventoryAnalyticsRuns", "run1")));
    await assertSucceeds(getDocs(query(collection(admin, "inventoryAnalyticsRuns"), orderBy("generatedAt", "desc"), limit(1))));
    await assertSucceeds(getDoc(doc(admin, "inventoryAnalyticsConfig", "vacAnalytics")));
    await assertSucceeds(getDocs(collection(admin, "inventoryAnalyticsConfig")));
  });

  await check("NAN1 Med Rep, Dispatcher, Rider and anonymous cannot read any analytics collection", async () => {
    for (const ctx of [salesRep, dispatcher, rider, anon]) {
      await assertFails(getDoc(doc(ctx, "inventoryForecasts", "vacAnalytics__all__30d")));
      await assertFails(getDocs(collection(ctx, "inventoryForecasts")));
      await assertFails(getDoc(doc(ctx, "inventoryAnalyticsRuns", "run1")));
      await assertFails(getDocs(collection(ctx, "inventoryAnalyticsRuns")));
      await assertFails(getDoc(doc(ctx, "inventoryAnalyticsConfig", "vacAnalytics")));
      await assertFails(getDocs(collection(ctx, "inventoryAnalyticsConfig")));
    }
  });

  await check("NAN2 no client — not even an Admin — creates, edits or deletes forecasts or run records", async () => {
    for (const ctx of [admin, salesRep, dispatcher, rider, anon]) {
      await assertFails(setDoc(doc(ctx, "inventoryForecasts", "vacAnalytics__all__7d"), { vaccineId: "vacAnalytics", horizonDays: 7 }));
      await assertFails(updateDoc(doc(ctx, "inventoryForecasts", "vacAnalytics__all__30d"), { predictedDemandQuantity: 0 }));
      await assertFails(deleteDoc(doc(ctx, "inventoryForecasts", "vacAnalytics__all__30d")));
      await assertFails(setDoc(doc(ctx, "inventoryAnalyticsRuns", "run2"), { runId: "run2" }));
      await assertFails(updateDoc(doc(ctx, "inventoryAnalyticsRuns", "run1"), { forecastCount: 0 }));
      await assertFails(deleteDoc(doc(ctx, "inventoryAnalyticsRuns", "run1")));
    }
  });

  await check("PAN2 an Admin saves a valid configuration, stamped with server time and their own uid", async () => {
    await assertSucceeds(setDoc(doc(admin, "inventoryAnalyticsConfig", "vacAnalytics"), analyticsConfig()));
    await assertSucceeds(setDoc(doc(admin, "inventoryAnalyticsConfig", "vacAnalytics"),
      analyticsConfig({ safetyStockQuantity: null, safetyStockDays: 7, enabled: false })));
    // The boundaries themselves are allowed: 0 and exactly 100,000,000 vials.
    await assertSucceeds(setDoc(doc(admin, "inventoryAnalyticsConfig", "vacAnalytics"),
      analyticsConfig({ safetyStockQuantity: 0 })));
    await assertSucceeds(setDoc(doc(admin, "inventoryAnalyticsConfig", "vacAnalytics"),
      analyticsConfig({ safetyStockQuantity: 100000000 })));
  });

  await check("NAN3 configuration validation is enforced", async () => {
    const ref = doc(admin, "inventoryAnalyticsConfig", "vacAnalytics");
    for (const bad of [
      analyticsConfig({ leadTimeDays: 0 }),
      analyticsConfig({ leadTimeDays: 366 }),
      analyticsConfig({ leadTimeDays: 2.5 }),
      analyticsConfig({ leadTimeDays: "14" }),
      analyticsConfig({ safetyStockQuantity: null }), // neither safety field
      analyticsConfig({ safetyStockDays: 3 }), // both safety fields
      analyticsConfig({ safetyStockQuantity: -1 }),
      analyticsConfig({ safetyStockQuantity: 100000001 }), // above the ceiling
      analyticsConfig({ safetyStockQuantity: 2.5 }), // decimal
      analyticsConfig({ safetyStockQuantity: NaN }),
      analyticsConfig({ safetyStockQuantity: Infinity }),
      analyticsConfig({ safetyStockQuantity: "20" }),
      analyticsConfig({ safetyStockQuantity: null, safetyStockDays: 2.5 }),
      analyticsConfig({ safetyStockQuantity: null, safetyStockDays: NaN }),
      analyticsConfig({ leadTimeDays: NaN }),
      analyticsConfig({ safetyStockQuantity: null, safetyStockDays: 400 }),
      analyticsConfig({ enabled: "yes" }),
      analyticsConfig({ updatedByUid: "someone-else" }), // not the caller
      analyticsConfig({ updatedAt: Timestamp.fromDate(new Date("2020-01-01T00:00:00Z")) }), // not server time
      analyticsConfig({ vaccineId: "other" }), // id mismatch
      analyticsConfig({ note: "x" }), // unknown field
    ]) {
      await assertFails(setDoc(ref, bad));
    }
    // Missing a required key.
    const missing = analyticsConfig();
    delete missing.enabled;
    await assertFails(setDoc(ref, missing));
    // Only for a real catalog vaccine.
    await assertFails(setDoc(doc(admin, "inventoryAnalyticsConfig", "noSuchVaccine"), analyticsConfig({ vaccineId: "noSuchVaccine" })));
    // Never deleted (disable it instead), and never written by another role.
    await assertFails(deleteDoc(ref));
    for (const ctx of [salesRep, dispatcher, rider]) {
      await assertFails(setDoc(ref, analyticsConfig({ updatedByUid: ctx === salesRep ? salesRepUid : ctx === dispatcher ? dispatcherUid : riderUid })));
    }
  });

  await check("NAN4 analytics changes nothing about inventory or order protections", async () => {
    // The new collections grant no path onto stock or orders: an Admin still
    // cannot move reserved stock directly (a real change to the counter).
    await assertFails(updateDoc(doc(admin, "inventory", "invAdmin"), { reservedQuantity: 5 }));
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
