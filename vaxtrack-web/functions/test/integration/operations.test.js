"use strict";

/**
 * The three operations against a REAL Firestore, via the emulator.
 *
 * Pure unit tests cannot prove the properties that matter most here —
 * atomicity, idempotency under genuine concurrency, and that a rejected call
 * leaves nothing behind. Those need real transactions with real contention, so
 * this suite drives the Admin SDK against the Firestore emulator.
 *
 * Run:  npm run test:emulator   (in functions/)
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

process.env.FIRESTORE_EMULATOR_HOST =
  process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181";
const PROJECT_ID = "demo-vaxtrack-functions";

admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

const ops = require("../../src/operations");

const SR = "sr_approved";
const SR2 = "sr_approved_2";
const SR_PENDING = "sr_pending";
const DISPATCHER = "disp_approved";
const DISP_DISABLED = "disp_disabled";
const RIDER = "rider_approved";
const RIDER_OTHER = "rider_other";
const RIDER_PENDING = "rider_pending";
const CLINIC = "clinic1";

const NOW = new Date("2026-09-06T02:00:00.000Z");
let seq = 0;
const rid = () => `req${String(++seq).padStart(4, "0")}${"x".repeat(20)}`;

/** VAT-exclusive selling prices, in centavos. ₱1,250.00 and ₱450.00. */
const PRICE = 125000;
const PRICES = { good: PRICE, second: 45000 };

async function wipe() {
  for (const c of ["users", "clinics", "inventory", "orders", "inventoryReservations", "orderRequestKeys"]) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

async function seed(inventory = {}) {
  await wipe();
  await db.collection("users").doc(SR).set({ role: "salesrep", status: "approved" });
  await db.collection("users").doc(SR2).set({ role: "salesrep", status: "approved" });
  await db.collection("users").doc(SR_PENDING).set({ role: "salesrep", status: "pending" });
  await db.collection("users").doc(DISPATCHER).set({ role: "dispatcher", status: "approved" });
  await db.collection("users").doc(DISP_DISABLED).set({ role: "dispatcher", status: "disabled" });
  await db.collection("users").doc(RIDER).set({
    role: "rider", status: "approved", employeeId: "EMP-4432", fullName: "QA Rider",
  });
  await db.collection("users").doc(RIDER_OTHER).set({ role: "rider", status: "approved" });
  await db.collection("users").doc(RIDER_PENDING).set({ role: "rider", status: "pending" });
  await db.collection("clinics").doc(CLINIC).set({ name: "Staging Health Clinic", location: "Manila" });

  const batches = {
    good: { quantity: 100, reservedQuantity: 0, sellingPriceCentavos: PRICES.good, status: "OK", expiryDate: "2027-12-31", batchId: "MOD-STG-001", vaccineName: "Moderna COVID-19 Vaccine", vaccineType: "COVID-19", manufacturer: "Moderna" },
    second: { quantity: 50, reservedQuantity: 5, sellingPriceCentavos: PRICES.second, status: "Low", expiryDate: "2027-10-30", batchId: "FLU-STG-002", vaccineName: "Flu Vaccine Quadrivalent", vaccineType: "Influenza" },
    legacyString: { quantity: "120", sellingPriceCentavos: PRICE, status: "OK", expiryDate: "2027-12-31", batchId: "HEP-STG-003", vaccineName: "Hepatitis B Vaccine" },
    badReserved: { quantity: 100, reservedQuantity: "5", sellingPriceCentavos: PRICE, status: "OK", expiryDate: "2027-12-31", batchId: "BAD-RES" },
    expired: { quantity: 100, reservedQuantity: 0, sellingPriceCentavos: PRICE, status: "OK", expiryDate: "2020-01-01", batchId: "EXP-001" },
    inactive: { quantity: 100, reservedQuantity: 0, sellingPriceCentavos: PRICE, status: "Recalled", expiryDate: "2027-12-31", batchId: "INACT-001" },
    lastUnit: { quantity: 1, reservedQuantity: 0, sellingPriceCentavos: PRICE, status: "OK", expiryDate: "2027-12-31", batchId: "LAST-001", vaccineName: "Last One" },
    shadowed: { quantity: 100, reservedQuantity: 0, sellingPriceCentavos: PRICE, status: "OK", expiryDate: "2027-12-31", batchId: "SHADOW-001", vaccineName: "Real Name", id: "ATTACKER_DOC_ID" },
    // Deliberately UNPRICED — the state every batch created before this
    // checkpoint is in, and the one ordering must refuse rather than sell at 0.
    unpriced: { quantity: 100, reservedQuantity: 0, status: "OK", expiryDate: "2027-12-31", batchId: "NOPRICE-001", vaccineName: "Unpriced Vaccine" },
    // Priced, but stored as TEXT — the same class of defect as a string
    // quantity, and refused for the same reason rather than coerced.
    stringPrice: { quantity: 100, reservedQuantity: 0, sellingPriceCentavos: "125000", status: "OK", expiryDate: "2027-12-31", batchId: "STRPRICE-001", vaccineName: "Text Price Vaccine" },
    ...inventory,
  };
  for (const [id, data] of Object.entries(batches)) {
    await db.collection("inventory").doc(id).set(data);
  }
}

/**
 * Every line must confirm a price, so this helper fills in the seeded one when
 * a case does not care — that keeps the pre-pricing cases below about what they
 * were always about (stock, expiry, identity, idempotency) instead of turning
 * every one of them into a pricing test. Cases that DO care pass an explicit
 * `expectedUnitPriceCentavos` and it is used verbatim.
 */
const create = (uid, items, over = {}) =>
  ops.createOrderWithReservation({
    db, FieldValue, uid, now: NOW,
    payload: {
      requestId: rid(),
      clinicDocId: CLINIC,
      items: items.map((i) =>
        "expectedUnitPriceCentavos" in i
          ? i
          : { ...i, expectedUnitPriceCentavos: PRICES[i.inventoryId] ?? PRICE }
      ),
      ...over,
    },
  });

const cancel = (uid, orderId, reason = "Clinic closed") =>
  ops.cancelOrderWithInventoryRelease({ db, FieldValue, uid, orderId, reason, now: NOW });

const deliver = (uid, orderId) =>
  ops.markOrderDeliveredWithInventoryConsumption({ db, FieldValue, uid, orderId, now: NOW });

const codeOf = async (p) => {
  try { await p; return null; } catch (e) { return e.code; }
};
const inv = async (id) => (await db.collection("inventory").doc(id).get()).data();
const order = async (id) => (await db.collection("orders").doc(id).get()).data();
const reservation = async (id) => {
  const s = await db.collection("inventoryReservations").doc(id).get();
  return s.exists ? s.data() : null;
};
const assign = (orderId, riderUid) =>
  db.collection("orders").doc(orderId).update({ assignedRiderId: riderUid, status: "in_transit" });

// ---------------------------------------------------------------- reservation

test("reservation: valid orders reserve without touching on-hand stock", async (t) => {
  await seed();

  await t.test("a single-batch order reserves exactly what was asked", async () => {
    const r = await create(SR, [{ inventoryId: "good", quantity: 10, expectedUnitPriceCentavos: PRICE }]);
    const b = await inv("good");
    assert.equal(b.quantity, 100, "on-hand is untouched by a reservation");
    assert.equal(b.reservedQuantity, 10);

    const o = await order(r.orderId);
    assert.equal(o.allocationVersion, 1);
    assert.equal(o.allocationStatus, "reserved");
    assert.equal(o.items[0].inventoryId, "good");
    assert.equal(o.status, "pending_dispatch");
    assert.equal(o.createdByUid, SR);
    assert.ok(o.reservedAt, "server timestamp written");

    const res = await reservation(r.orderId);
    assert.equal(res.status, "reserved");
    assert.deepEqual(res.items, [{ inventoryId: "good", batchId: "MOD-STG-001", quantity: 10 }]);
    assert.match(r.orderNumber, /^VT-ORD-\d+-[A-Z0-9]{4}$/);
  });

  await t.test("multiple distinct batches reserve independently", async () => {
    const r = await create(SR, [
      { inventoryId: "good", quantity: 5, expectedUnitPriceCentavos: PRICE },
      { inventoryId: "second", quantity: 3 },
    ]);
    assert.equal((await inv("good")).reservedQuantity, 15); // 10 from above + 5
    assert.equal((await inv("second")).reservedQuantity, 8); // seeded 5 + 3
    assert.equal((await reservation(r.orderId)).items.length, 2);
  });
});

test("reservation: refusals leave nothing behind", async (t) => {
  await seed();
  const before = { orders: (await db.collection("orders").get()).size };

  const cases = [
    ["missing inventory", [{ inventoryId: "nope", quantity: 1 }], "inventory-not-found"],
    ["legacy string quantity", [{ inventoryId: "legacyString", quantity: 1 }], "inventory-migration-required"],
    ["invalid reservedQuantity", [{ inventoryId: "badReserved", quantity: 1 }], "inventory-invalid-reserved"],
    ["expired batch", [{ inventoryId: "expired", quantity: 1 }], "batch-expired"],
    ["inactive batch", [{ inventoryId: "inactive", quantity: 1 }], "batch-unavailable"],
    ["duplicate inventory ids", [{ inventoryId: "good", quantity: 1, expectedUnitPriceCentavos: PRICE }, { inventoryId: "good", quantity: 2, expectedUnitPriceCentavos: PRICE }], "duplicate-inventory-line"],
    ["insufficient stock", [{ inventoryId: "good", quantity: 101, expectedUnitPriceCentavos: PRICE }], "insufficient-stock"],
    ["zero quantity", [{ inventoryId: "good", quantity: 0, expectedUnitPriceCentavos: PRICE }], "invalid-quantity"],
    ["negative quantity", [{ inventoryId: "good", quantity: -5 }], "invalid-quantity"],
    ["decimal quantity", [{ inventoryId: "good", quantity: 2.5 }], "invalid-quantity"],
    ["string quantity", [{ inventoryId: "good", quantity: "5" }], "invalid-quantity"],
    ["NaN quantity", [{ inventoryId: "good", quantity: NaN }], "invalid-quantity"],
    ["undefined quantity", [{ inventoryId: "good" }], "invalid-quantity"],
    ["oversized quantity", [{ inventoryId: "good", quantity: 1000001, expectedUnitPriceCentavos: PRICE }], "quantity-too-large"],
  ];

  for (const [name, items, expected] of cases) {
    await t.test(`refuses: ${name}`, async () => {
      assert.equal(await codeOf(create(SR, items)), expected);
    });
  }

  await t.test("no order, reservation or counter change survives a refusal", async () => {
    assert.equal((await db.collection("orders").get()).size, before.orders);
    assert.equal((await db.collection("inventoryReservations").get()).size, 0);
    assert.equal((await inv("good")).reservedQuantity, 0);
    assert.equal((await inv("good")).quantity, 100);
  });
});

test("reservation: caller data can never override server identity", async (t) => {
  await seed();

  await t.test("a stored `id` field does not become the allocation identity", async () => {
    const r = await create(SR, [{ inventoryId: "shadowed", quantity: 1 }]);
    const o = await order(r.orderId);
    assert.equal(o.items[0].inventoryId, "shadowed", "the DOCUMENT id wins");
    assert.notEqual(o.items[0].inventoryId, "ATTACKER_DOC_ID");
    assert.equal((await reservation(r.orderId)).items[0].inventoryId, "shadowed");
  });

  await t.test("display fields are snapshotted from the document", async () => {
    const r = await create(SR, [{ inventoryId: "shadowed", quantity: 1 }]);
    const o = await order(r.orderId);
    assert.equal(o.items[0].name, "Real Name");
    assert.equal(o.items[0].batchId, "SHADOW-001");
  });

  await t.test("unknown item fields are rejected outright", async () => {
    assert.equal(
      await codeOf(create(SR, [{ inventoryId: "good", quantity: 1, name: "Free Vaccine" }])),
      "unknown-field"
    );
  });

  await t.test("audit uid comes from the session, not the payload", async () => {
    const r = await ops.createOrderWithReservation({
      db, FieldValue, uid: SR, now: NOW,
      payload: { requestId: rid(), clinicDocId: CLINIC, items: [{ inventoryId: "good", quantity: 1, expectedUnitPriceCentavos: PRICE }] },
    });
    assert.equal((await order(r.orderId)).createdByUid, SR);
  });
});

test("reservation: stock moving under an open checkout is caught", async () => {
  await seed();
  // Catalog said 100 available; another order takes 95 before checkout commits.
  await create(SR2, [{ inventoryId: "good", quantity: 95, expectedUnitPriceCentavos: PRICE }]);
  assert.equal(await codeOf(create(SR, [{ inventoryId: "good", quantity: 10, expectedUnitPriceCentavos: PRICE }])), "insufficient-stock");
  assert.equal((await inv("good")).reservedQuantity, 95, "the failed attempt reserved nothing");
});

test("reservation RACE: two reps chasing the final unit — exactly one wins", async () => {
  await seed();
  const results = await Promise.allSettled([
    create(SR, [{ inventoryId: "lastUnit", quantity: 1 }]),
    create(SR2, [{ inventoryId: "lastUnit", quantity: 1 }]),
  ]);
  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  assert.equal(won.length, 1, "exactly one reservation succeeds");
  assert.equal(lost.length, 1);
  assert.equal(lost[0].reason.code, "insufficient-stock");

  const b = await inv("lastUnit");
  assert.equal(b.reservedQuantity, 1, "never oversold");
  assert.equal(b.quantity, 1, "on-hand untouched");
  assert.equal((await db.collection("inventoryReservations").get()).size, 1);
});

// ------------------------------------------------------------------- pricing

test("pricing: the order carries a server-generated snapshot", async (t) => {
  await seed();

  await t.test("prices come from the BATCH, and the line total is computed", async () => {
    const r = await create(SR, [{ inventoryId: "good", quantity: 4, expectedUnitPriceCentavos: PRICE }]);
    const o = await order(r.orderId);

    assert.equal(o.pricingVersion, 1);
    assert.equal(o.priceCurrency, "PHP");
    assert.equal(o.priceIsVatInclusive, false, "the invoice adds 12% on top of this");
    assert.ok(o.pricedAt, "server timestamp written");

    assert.equal(o.items[0].unitPriceCentavos, PRICE);
    assert.equal(o.items[0].lineTotalCentavos, 4 * PRICE);
    assert.equal(o.items[0].unitPrice, 1250, "peso mirror for the invoice layer");
    assert.equal(o.subtotalCentavos, 4 * PRICE);
    assert.equal(o.subtotal, 5000);
  });

  await t.test("a multi-batch subtotal sums each line's own price", async () => {
    const r = await create(SR, [
      { inventoryId: "good", quantity: 2 },   // 2 x ₱1,250.00
      { inventoryId: "second", quantity: 3 }, // 3 x ₱450.00
    ]);
    const o = await order(r.orderId);
    assert.equal(o.items[0].unitPriceCentavos, PRICES.good);
    assert.equal(o.items[1].unitPriceCentavos, PRICES.second);
    assert.equal(o.subtotalCentavos, 2 * PRICES.good + 3 * PRICES.second);
    assert.equal(o.subtotalCentavos, 385000); // ₱3,850.00
  });

  await t.test("the reservation stays about STOCK — it stores no price", async () => {
    // A second place holding a price is a second place that can disagree with
    // the first, and nothing would keep them in step.
    const r = await create(SR, [{ inventoryId: "good", quantity: 1, expectedUnitPriceCentavos: PRICE }]);
    const res = await reservation(r.orderId);
    for (const item of res.items) {
      assert.deepEqual(Object.keys(item).sort(), ["batchId", "inventoryId", "quantity"]);
    }
  });

  await t.test("no `unitPrice` from the caller survives — it is refused outright", async () => {
    // Earlier subtests in this suite share one seed, so the assertion is that
    // the refused call changes NOTHING — not that the counter is zero.
    const before = (await inv("good")).reservedQuantity;
    const code = await codeOf(
      create(SR, [
        { inventoryId: "good", quantity: 1, expectedUnitPriceCentavos: PRICE, unitPrice: 0.01 },
      ])
    );
    assert.equal(code, "unknown-field");
    assert.equal((await inv("good")).reservedQuantity, before, "nothing reserved");
  });
});

test("pricing: refusals leave nothing behind", async (t) => {
  const cases = [
    ["reduced price", [{ inventoryId: "good", quantity: 1, expectedUnitPriceCentavos: 1 }], "price-changed"],
    ["inflated price", [{ inventoryId: "good", quantity: 1, expectedUnitPriceCentavos: PRICE * 2 }], "price-changed"],
    ["negative price", [{ inventoryId: "good", quantity: 1, expectedUnitPriceCentavos: -PRICE }], "invalid-expected-price"],
    ["zero price", [{ inventoryId: "good", quantity: 1, expectedUnitPriceCentavos: 0 }], "invalid-expected-price"],
    ["string price", [{ inventoryId: "good", quantity: 1, expectedUnitPriceCentavos: "125000" }], "invalid-expected-price"],
    ["decimal price", [{ inventoryId: "good", quantity: 1, expectedUnitPriceCentavos: 1250.5 }], "invalid-expected-price"],
    ["missing price", [{ inventoryId: "good", quantity: 1, expectedUnitPriceCentavos: undefined }], "price-not-confirmed"],
    ["unpriced batch", [{ inventoryId: "unpriced", quantity: 1 }], "batch-unpriced"],
    ["text price on the batch", [{ inventoryId: "stringPrice", quantity: 1 }], "batch-unpriced"],
  ];

  for (const [label, items, expected] of cases) {
    await t.test(label, async () => {
      await seed();
      assert.equal(await codeOf(create(SR, items)), expected);
      // The property that matters: a refused checkout moves NOTHING.
      assert.equal((await db.collection("orders").get()).size, 0, "no order");
      assert.equal((await db.collection("inventoryReservations").get()).size, 0, "no reservation");
      assert.equal((await db.collection("orderRequestKeys").get()).size, 0, "no key burned");
      for (const id of ["good", "unpriced", "stringPrice"]) {
        assert.equal((await inv(id)).reservedQuantity ?? 0, 0, `${id} untouched`);
      }
    });
  }
});

test("pricing RACE: a re-price landing under an open checkout is caught", async () => {
  // The real-world sequence this exists for: a rep loads the catalog at
  // ₱1,250.00, an admin re-prices the batch to ₱1,400.00, and the rep checks
  // out moments later. The old code would have stored whatever the client sent.
  await seed();
  await db.collection("inventory").doc("good").update({ sellingPriceCentavos: 140000 });

  const code = await codeOf(
    create(SR, [{ inventoryId: "good", quantity: 2, expectedUnitPriceCentavos: PRICE }])
  );
  assert.equal(code, "price-changed", "the stale cart is refused, not silently re-priced");
  assert.equal((await db.collection("orders").get()).size, 0);
  assert.equal((await inv("good")).reservedQuantity, 0);

  // Rebuilt at the price now on the batch, the same order goes through — and
  // records the NEW price, not the one the rep first saw.
  const r = await create(SR, [{ inventoryId: "good", quantity: 2, expectedUnitPriceCentavos: 140000 }]);
  const o = await order(r.orderId);
  assert.equal(o.items[0].unitPriceCentavos, 140000);
  assert.equal(o.subtotalCentavos, 280000);
});

test("pricing: a placed order's snapshot is immutable against later re-pricing", async () => {
  await seed();
  const r = await create(SR, [{ inventoryId: "good", quantity: 3, expectedUnitPriceCentavos: PRICE }]);
  const before = await order(r.orderId);

  // The admin re-prices the batch AFTER the order exists...
  await db.collection("inventory").doc("good").update({ sellingPriceCentavos: 999900 });

  // ...and the order still says what the clinic was actually quoted. Re-deriving
  // this from today's catalog would misreport a completed transaction.
  const after = await order(r.orderId);
  assert.equal(after.items[0].unitPriceCentavos, PRICE);
  assert.equal(after.subtotalCentavos, before.subtotalCentavos);

  // The whole delivery lifecycle runs without disturbing it either.
  await assign(r.orderId, RIDER);
  await deliver(RIDER, r.orderId);
  const delivered = await order(r.orderId);
  assert.equal(delivered.status, "delivered");
  assert.equal(delivered.items[0].unitPriceCentavos, PRICE);
  assert.equal(delivered.subtotalCentavos, 3 * PRICE);
});

test("pricing: a legacy order keeps manual invoice pricing and is never back-filled", async () => {
  await seed();
  // An order as it existed before this checkpoint: no allocation, no pricing.
  const legacyRef = db.collection("orders").doc();
  await legacyRef.set({
    orderNumber: "VT-ORD-LEGACY-PRICE",
    status: "in_transit",
    assignedRiderId: RIDER,
    items: [{ name: "Moderna COVID-19 Vaccine", sku: "MOD-STG-001", quantity: 5, unitPrice: 0 }],
    createdByUid: SR,
  });

  await deliver(RIDER, legacyRef.id);
  const o = await order(legacyRef.id);

  assert.equal(o.status, "delivered");
  assert.equal(o.inventoryReconciliation, "legacy-unallocated");
  assert.equal(o.pricingVersion, undefined, "no version stamp invented");
  assert.equal(o.subtotalCentavos, undefined, "no subtotal invented");
  assert.equal(o.items[0].unitPriceCentavos, undefined, "no price invented");
  assert.equal(o.items[0].unitPrice, 0, "its own figures are left exactly as they were");
});

// --------------------------------------------------------------- idempotency

test("idempotency", async (t) => {
  await seed();

  await t.test("five simultaneous identical submits create exactly ONE order", async () => {
    const requestId = rid();
    const payload = { requestId, clinicDocId: CLINIC, items: [{ inventoryId: "good", quantity: 4, expectedUnitPriceCentavos: PRICE }] };
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        ops.createOrderWithReservation({ db, FieldValue, uid: SR, payload, now: NOW })
      )
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    assert.equal(ok.length, 5, "every caller gets an answer, not an error");
    const ids = new Set(ok.map((r) => r.value.orderId));
    assert.equal(ids.size, 1, "all five name the same order");

    assert.equal((await db.collection("orders").get()).size, 1);
    assert.equal((await db.collection("inventoryReservations").get()).size, 1);
    assert.equal((await inv("good")).reservedQuantity, 4, "reserved once, not five times");
  });

  await t.test("a later retry replays the original result without reserving again", async () => {
    const requestId = rid();
    const payload = { requestId, clinicDocId: CLINIC, items: [{ inventoryId: "good", quantity: 7, expectedUnitPriceCentavos: PRICE }] };
    const first = await ops.createOrderWithReservation({ db, FieldValue, uid: SR, payload, now: NOW });
    const reservedAfterFirst = (await inv("good")).reservedQuantity;

    const replay = await ops.createOrderWithReservation({ db, FieldValue, uid: SR, payload, now: NOW });
    assert.equal(replay.orderId, first.orderId);
    assert.equal(replay.orderNumber, first.orderNumber);
    assert.equal(replay.replayed, true);
    assert.equal((await inv("good")).reservedQuantity, reservedAfterFirst);
  });

  await t.test("the same key with different contents is refused", async () => {
    const requestId = rid();
    await ops.createOrderWithReservation({
      db, FieldValue, uid: SR, now: NOW,
      payload: { requestId, clinicDocId: CLINIC, items: [{ inventoryId: "good", quantity: 1, expectedUnitPriceCentavos: PRICE }] },
    });
    const code = await codeOf(
      ops.createOrderWithReservation({
        db, FieldValue, uid: SR, now: NOW,
        payload: { requestId, clinicDocId: CLINIC, items: [{ inventoryId: "good", quantity: 2, expectedUnitPriceCentavos: PRICE }] },
      })
    );
    assert.equal(code, "idempotency-conflict");
  });

  await t.test("the key is scoped to the caller", async () => {
    const requestId = rid();
    const items = [{ inventoryId: "good", quantity: 1, expectedUnitPriceCentavos: PRICE }];
    const a = await ops.createOrderWithReservation({ db, FieldValue, uid: SR, now: NOW, payload: { requestId, clinicDocId: CLINIC, items } });
    const b = await ops.createOrderWithReservation({ db, FieldValue, uid: SR2, now: NOW, payload: { requestId, clinicDocId: CLINIC, items } });
    assert.notEqual(a.orderId, b.orderId, "one rep's key cannot replay another's order");
  });

  await t.test("different keys create distinct orders and reservations", async () => {
    const items = [{ inventoryId: "good", quantity: 1, expectedUnitPriceCentavos: PRICE }];
    const a = await create(SR, items);
    const b = await create(SR, items);
    assert.notEqual(a.orderId, b.orderId);
    assert.notEqual((await reservation(a.orderId)), null);
    assert.notEqual((await reservation(b.orderId)), null);
  });
});

// ---------------------------------------------------------- release / consume

test("cancellation releases exactly once", async (t) => {
  await seed();

  await t.test("releases the reservation and leaves on-hand alone", async () => {
    const r = await create(SR, [{ inventoryId: "good", quantity: 10, expectedUnitPriceCentavos: PRICE }]);
    assert.equal((await inv("good")).reservedQuantity, 10);

    const out = await cancel(DISPATCHER, r.orderId);
    assert.equal(out.released, true);
    const b = await inv("good");
    assert.equal(b.reservedQuantity, 0, "reservation released");
    assert.equal(b.quantity, 100, "on-hand never moves on a cancellation");

    const o = await order(r.orderId);
    assert.equal(o.status, "cancelled");
    assert.equal(o.allocationStatus, "released");
    assert.equal(o.releasedByUid, DISPATCHER);
    assert.equal(o.cancelReason, "Clinic closed");
    assert.equal((await reservation(r.orderId)).status, "released");
    assert.equal((await reservation(r.orderId)).settlementType, "cancelled");
  });

  await t.test("a repeated cancellation does not release twice", async () => {
    const r = await create(SR, [{ inventoryId: "good", quantity: 10, expectedUnitPriceCentavos: PRICE }]);
    await cancel(DISPATCHER, r.orderId);
    const afterFirst = (await inv("good")).reservedQuantity;
    const replay = await cancel(DISPATCHER, r.orderId);
    assert.equal(replay.replayed, true);
    assert.equal(replay.released, false);
    assert.equal((await inv("good")).reservedQuantity, afterFirst);
  });

  await t.test("requires a meaningful reason", async () => {
    const r = await create(SR, [{ inventoryId: "good", quantity: 1, expectedUnitPriceCentavos: PRICE }]);
    assert.equal(await codeOf(cancel(DISPATCHER, r.orderId, "   ")), "reason-required");
    assert.equal(await codeOf(cancel(DISPATCHER, r.orderId, "x".repeat(501))), "reason-too-long");
    assert.equal((await order(r.orderId)).status, "pending_dispatch", "nothing changed");
  });
});

test("delivery consumes exactly once", async (t) => {
  await seed();

  await t.test("deducts on-hand and clears the reservation together", async () => {
    const r = await create(SR, [{ inventoryId: "good", quantity: 10, expectedUnitPriceCentavos: PRICE }]);
    await assign(r.orderId, RIDER);

    const out = await deliver(RIDER, r.orderId);
    assert.equal(out.consumed, true);
    const b = await inv("good");
    assert.equal(b.quantity, 90, "on-hand deducted once");
    assert.equal(b.reservedQuantity, 0, "reservation consumed");

    const o = await order(r.orderId);
    assert.equal(o.status, "delivered");
    assert.equal(o.allocationStatus, "consumed");
    assert.equal(o.consumedByUid, RIDER);
    assert.ok(o.deliveredAt);
    assert.equal((await reservation(r.orderId)).settlementType, "delivered");
  });

  await t.test("a repeated delivery does not deduct twice", async () => {
    const r = await create(SR, [{ inventoryId: "good", quantity: 10, expectedUnitPriceCentavos: PRICE }]);
    await assign(r.orderId, RIDER);
    await deliver(RIDER, r.orderId);
    const afterFirst = (await inv("good")).quantity;
    const replay = await deliver(RIDER, r.orderId);
    assert.equal(replay.replayed, true);
    assert.equal(replay.consumed, false);
    assert.equal((await inv("good")).quantity, afterFirst);
  });

  await t.test("delivery is refused from a status that is not in_transit/delayed", async () => {
    const r = await create(SR, [{ inventoryId: "good", quantity: 1, expectedUnitPriceCentavos: PRICE }]);
    await db.collection("orders").doc(r.orderId).update({ assignedRiderId: RIDER, status: "assigned" });
    assert.equal(await codeOf(deliver(RIDER, r.orderId)), "invalid-status-transition");
  });
});

test("cross-settlement is impossible", async (t) => {
  await seed();

  await t.test("a consumed reservation cannot be released", async () => {
    const r = await create(SR, [{ inventoryId: "good", quantity: 5, expectedUnitPriceCentavos: PRICE }]);
    await assign(r.orderId, RIDER);
    await deliver(RIDER, r.orderId);
    assert.equal(await codeOf(cancel(DISPATCHER, r.orderId)), "invalid-status-transition");
    assert.equal((await inv("good")).quantity, 95, "no extra movement");
  });

  await t.test("a released reservation cannot be consumed", async () => {
    const r = await create(SR, [{ inventoryId: "good", quantity: 5, expectedUnitPriceCentavos: PRICE }]);
    await assign(r.orderId, RIDER);
    await cancel(DISPATCHER, r.orderId);
    assert.equal(await codeOf(deliver(RIDER, r.orderId)), "invalid-status-transition");
    const b = await inv("good");
    assert.equal(b.quantity, 95, "cancellation must not have deducted on-hand");
  });
});

test("RACE: cancellation against delivery yields one terminal outcome", async () => {
  await seed();
  const r = await create(SR, [{ inventoryId: "good", quantity: 10, expectedUnitPriceCentavos: PRICE }]);
  await assign(r.orderId, RIDER);
  const onHandBefore = (await inv("good")).quantity;

  const [a, b] = await Promise.allSettled([cancel(DISPATCHER, r.orderId), deliver(RIDER, r.orderId)]);
  const winners = [a, b].filter((x) => x.status === "fulfilled");
  assert.equal(winners.length, 1, "exactly one settles the order");

  const o = await order(r.orderId);
  const res = await reservation(r.orderId);
  const invAfter = await inv("good");

  if (o.status === "delivered") {
    assert.equal(res.status, "consumed");
    assert.equal(invAfter.quantity, onHandBefore - 10);
  } else {
    assert.equal(o.status, "cancelled");
    assert.equal(res.status, "released");
    assert.equal(invAfter.quantity, onHandBefore, "a cancellation never deducts on-hand");
  }
  assert.equal(invAfter.reservedQuantity, 0, "settled exactly once either way");
  assert.ok(invAfter.quantity >= 0 && invAfter.reservedQuantity >= 0, "invariants hold");
});

// -------------------------------------------------------------- authorization

test("authorization", async (t) => {
  await seed();
  const r = await create(SR, [{ inventoryId: "good", quantity: 1, expectedUnitPriceCentavos: PRICE }]);
  await assign(r.orderId, RIDER);

  await t.test("creation requires an APPROVED sales rep", async () => {
    assert.equal(await codeOf(create(DISPATCHER, [{ inventoryId: "good", quantity: 1, expectedUnitPriceCentavos: PRICE }])), "wrong-role");
    assert.equal(await codeOf(create(RIDER, [{ inventoryId: "good", quantity: 1, expectedUnitPriceCentavos: PRICE }])), "wrong-role");
    assert.equal(await codeOf(create(SR_PENDING, [{ inventoryId: "good", quantity: 1, expectedUnitPriceCentavos: PRICE }])), "not-approved");
    assert.equal(await codeOf(create("ghost_uid", [{ inventoryId: "good", quantity: 1, expectedUnitPriceCentavos: PRICE }])), "profile-missing");
  });

  await t.test("cancellation requires an APPROVED dispatcher", async () => {
    assert.equal(await codeOf(cancel(SR, r.orderId)), "wrong-role");
    assert.equal(await codeOf(cancel(RIDER, r.orderId)), "wrong-role");
    assert.equal(await codeOf(cancel(DISP_DISABLED, r.orderId)), "not-approved");
  });

  await t.test("delivery requires the APPROVED, ASSIGNED rider", async () => {
    assert.equal(await codeOf(deliver(DISPATCHER, r.orderId)), "wrong-role");
    assert.equal(await codeOf(deliver(RIDER_OTHER, r.orderId)), "not-assigned-rider");
    assert.equal(await codeOf(deliver(RIDER_PENDING, r.orderId)), "not-approved");
  });

  await t.test("an employee id, name or uid fragment is not an identity", async () => {
    for (const fake of ["EMP-4432", "QA Rider", RIDER.slice(0, 5), RIDER.toUpperCase()]) {
      assert.equal(await codeOf(deliver(fake, r.orderId)), "profile-missing", fake);
    }
  });

  await t.test("nothing moved during any of the refusals", async () => {
    assert.equal((await order(r.orderId)).status, "in_transit");
    assert.equal((await reservation(r.orderId)).status, "reserved");
  });
});

// --------------------------------------------------------------------- legacy

test("legacy orders keep their lifecycle and move no stock", async (t) => {
  await seed();

  const makeLegacy = async (status) => {
    const ref = db.collection("orders").doc();
    await ref.set({
      orderNumber: "VT-ORD-legacy",
      status,
      createdByUid: SR,
      assignedRiderId: RIDER,
      // No allocationVersion, and items carry only the old ambiguous `sku`.
      items: [{ name: "Test Vaccine", sku: "TV-001", quantity: 5, unitPrice: 0 }],
    });
    return ref.id;
  };

  await t.test("cancellation changes status only, with an explicit marker", async () => {
    const id = await makeLegacy("in_transit");
    const before = await inv("good");
    const out = await cancel(DISPATCHER, id);
    assert.equal(out.legacy, true);
    assert.equal(out.released, false);

    const o = await order(id);
    assert.equal(o.status, "cancelled");
    assert.equal(o.inventoryReconciliation, "legacy-unallocated");
    assert.equal(o.allocationStatus, undefined, "no allocation is invented");
    assert.deepEqual(o.items, [{ name: "Test Vaccine", sku: "TV-001", quantity: 5, unitPrice: 0 }], "items untouched");
    assert.equal(await reservation(id), null, "no reservation is fabricated");
    assert.deepEqual(await inv("good"), before, "no batch was guessed at");
  });

  await t.test("delivery changes status only, with an explicit marker", async () => {
    const id = await makeLegacy("in_transit");
    const before = await inv("good");
    const out = await deliver(RIDER, id);
    assert.equal(out.legacy, true);
    assert.equal(out.consumed, false);

    const o = await order(id);
    assert.equal(o.status, "delivered");
    assert.equal(o.inventoryReconciliation, "legacy-unallocated");
    assert.ok(o.deliveredAt);
    assert.deepEqual(await inv("good"), before, "no deduction from an inferred batch");
  });

  await t.test("an order whose sku matches a real batch is STILL not deducted", async () => {
    // "MOD-STG-001" is a real batchId. Matching it would be a guess, and the
    // absence of allocationVersion is the only signal that counts.
    const ref = db.collection("orders").doc();
    await ref.set({
      status: "in_transit", createdByUid: SR, assignedRiderId: RIDER,
      items: [{ name: "Moderna COVID-19 Vaccine", sku: "MOD-STG-001", quantity: 5 }],
    });
    const before = await inv("good");
    await deliver(RIDER, ref.id);
    assert.deepEqual(await inv("good"), before);
  });
});

test("intermediate lifecycle changes have no inventory effect", async () => {
  await seed();
  const r = await create(SR, [{ inventoryId: "good", quantity: 10, expectedUnitPriceCentavos: PRICE }]);
  const snapshot = await inv("good");

  // Assignment, loading, dispatch, delay, failure and reassignment are all
  // written by their existing paths and are not inventory events.
  for (const status of ["assigned", "loading", "in_transit", "delayed", "in_transit", "delivery_failed", "assigned"]) {
    await db.collection("orders").doc(r.orderId).update({ status });
    assert.deepEqual(await inv("good"), snapshot, `status ${status} must not move stock`);
  }
  assert.equal((await reservation(r.orderId)).status, "reserved", "reservation survives the whole run");
});

test.after(async () => {
  await wipe();
  await admin.app().delete();
});
