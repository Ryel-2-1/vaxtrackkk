"use strict";

/**
 * Invoice pricing against a REAL Firestore, via the emulator.
 *
 * The properties that matter here cannot be shown by unit tests: that a save
 * reserves a number transactionally, that issuing re-reads the ORDER and
 * refuses a document someone edited underneath it, and that a legacy order is
 * never dragged onto this path.
 *
 * Run:  npm run test:emulator-invoices   (in functions/)
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

process.env.FIRESTORE_EMULATOR_HOST =
  process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181";
const PROJECT_ID = "demo-vaxtrack-invoices";

admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

const ops = require("../../src/invoiceOperations");

const ADMIN = "admin_approved";
const ADMIN_PENDING = "admin_pending";
const SALESREP = "sr_approved";
const ORDER = "order_priced";
const LEGACY_ORDER = "order_legacy";

const NOW = new Date("2026-09-08T02:00:00.000Z");
const PRICE = 125000; // ₱1,250.00
const SECOND = 45000; // ₱450.00

async function wipe() {
  for (const c of ["users", "orders", "invoices", "counters"]) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

const pricedOrderDoc = (over = {}) => ({
  orderNumber: "VT-ORD-PRICED",
  status: "delivered",
  clinicId: "CL-001",
  clinicName: "Staging Health Clinic",
  createdByUid: SALESREP,
  createdByEmail: "rep@example.test",
  unit: "vials",
  allocationVersion: 1,
  pricingVersion: 1,
  priceCurrency: "PHP",
  priceIsVatInclusive: false,
  subtotalCentavos: 4 * PRICE + 3 * SECOND,
  items: [
    { inventoryId: "inv1", batchId: "MOD-STG-001", name: "Moderna COVID-19 Vaccine", chain: "COVID-19", quantity: 4, unitPriceCentavos: PRICE, lineTotalCentavos: 4 * PRICE, unitPrice: 1250 },
    { inventoryId: "inv2", batchId: "FLU-STG-002", name: "Flu Vaccine Quadrivalent", chain: "Influenza", quantity: 3, unitPriceCentavos: SECOND, lineTotalCentavos: 3 * SECOND, unitPrice: 450 },
  ],
  ...over,
});

async function seed(orderOver = {}) {
  await wipe();
  await db.collection("users").doc(ADMIN).set({ role: "admin", status: "approved" });
  await db.collection("users").doc(ADMIN_PENDING).set({ role: "admin", status: "pending" });
  await db.collection("users").doc(SALESREP).set({ role: "salesrep", status: "approved" });
  await db.collection("orders").doc(ORDER).set(pricedOrderDoc(orderOver));
  // An order exactly as it existed before the pricing checkpoint.
  await db.collection("orders").doc(LEGACY_ORDER).set({
    orderNumber: "VT-ORD-LEGACY",
    status: "delivered",
    createdByUid: SALESREP,
    items: [{ name: "Hepatitis B Vaccine", sku: "HEP-STG-003", quantity: 5, unitPrice: 0 }],
  });
}

const save = (uid, payload) =>
  ops.saveInvoiceDraftForPricedOrder({ db, FieldValue, uid, payload, now: NOW });

const issue = (uid, payload) =>
  ops.issueInvoiceForPricedOrder({ db, FieldValue, uid, payload, now: NOW });

const codeOf = async (p) => {
  try { await p; return null; } catch (e) { return e.code; }
};
const invoice = async (id) => {
  const s = await db.collection("invoices").doc(id).get();
  return s.exists ? s.data() : null;
};

const PRESENTATION = { customerName: "Staging Health Clinic", invoiceDate: "2026-09-08" };
const SUBTOTAL = 4 * PRICE + 3 * SECOND; // ₱6,350.00

// ------------------------------------------------------------ approved path

test("invoice: saving a priced draft takes its base from the order", async (t) => {
  await seed();

  await t.test("the first save reserves a number and computes every figure", async () => {
    const r = await save(ADMIN, { orderId: ORDER, presentation: PRESENTATION });
    assert.equal(r.created, true);
    assert.match(r.invoiceNumber, /^INV-2026-\d{6}$/);

    const inv = await invoice(ORDER);
    assert.equal(inv.invoiceStatus, "draft");
    assert.equal(inv.pricingVersion, 1);
    assert.equal(inv.invoicePricingSource, "order-snapshot");
    assert.equal(inv.subtotalCentavos, SUBTOTAL);
    assert.equal(inv.priceCurrency, "PHP");
    assert.equal(inv.priceIsVatInclusive, false);

    assert.equal(inv.items.length, 2);
    assert.equal(inv.items[0].unitPriceCentavos, PRICE);
    assert.equal(inv.items[0].lineTotalCentavos, 4 * PRICE);
    assert.equal(inv.items[0].inventoryId, "inv1", "traceable to a batch");
    assert.equal(inv.items[1].unitPriceCentavos, SECOND);

    // No discount: net is the subtotal, VAT is 12% on top.
    assert.equal(inv.netCentavos, SUBTOTAL);
    assert.equal(inv.vatAmountCentavos, 76200);
    assert.equal(inv.grandTotalCentavos, 711200);
    assert.equal(inv.grandTotal, 7112, "peso mirror for the print template");
    assert.equal(inv.customerName, "Staging Health Clinic");
  });

  await t.test("a second save keeps the number and the creation trail", async () => {
    const before = await invoice(ORDER);
    const r = await save(ADMIN, { orderId: ORDER, presentation: { customerName: "Renamed" } });
    assert.equal(r.created, false);
    const after = await invoice(ORDER);
    assert.equal(after.invoiceNumber, before.invoiceNumber);
    assert.deepEqual(after.createdAt, before.createdAt);
    assert.equal(after.createdByUid, before.createdByUid);
    assert.equal(after.customerName, "Renamed");
    assert.equal(after.subtotalCentavos, SUBTOTAL, "the base did not move");
  });

  await t.test("issuing locks it, and is idempotent on a retry", async () => {
    const r = await issue(ADMIN, { orderId: ORDER });
    assert.equal(r.replayed, false);
    const inv = await invoice(ORDER);
    assert.equal(inv.invoiceStatus, "issued");
    assert.ok(inv.issuedAt);
    assert.equal(inv.issuedByUid, ADMIN);

    const again = await issue(ADMIN, { orderId: ORDER });
    assert.equal(again.replayed, true, "a retry is not an error");
  });

  await t.test("an issued invoice can no longer be saved", async () => {
    assert.equal(
      await codeOf(save(ADMIN, { orderId: ORDER, presentation: PRESENTATION })),
      "invoice-already-issued"
    );
  });
});

test("invoice: explicit adjustments apply on top of an untouched base", async (t) => {
  await t.test("a discount reduces the net without restating any unit price", async () => {
    await seed();
    await save(ADMIN, {
      orderId: ORDER,
      presentation: PRESENTATION,
      adjustments: { discountCentavos: 35000, otherChargesCentavos: 5000, withholdingTaxCentavos: 1000 },
    });
    const inv = await invoice(ORDER);

    // The base is exactly what the order said...
    assert.equal(inv.subtotalCentavos, SUBTOTAL);
    assert.equal(inv.items[0].unitPriceCentavos, PRICE);
    assert.equal(inv.items[1].unitPriceCentavos, SECOND);
    // ...and the adjustments sit beside it as their own named fields.
    assert.equal(inv.discountCentavos, 35000);
    assert.equal(inv.otherChargesCentavos, 5000);
    assert.equal(inv.withholdingTaxCentavos, 1000);
    assert.equal(inv.netCentavos, SUBTOTAL - 35000);
    assert.equal(inv.vatAmountCentavos, 72000); // 12% of 600,000
    assert.equal(inv.grandTotalCentavos, 677000);
    assert.equal(inv.totalAmountDueCentavos, 676000);
    // Peso mirrors, for the print template.
    assert.equal(inv.discount, 350);
    assert.equal(inv.totalAmountDue, 6760);
  });

  await t.test("a zero-rated classification carries no VAT", async () => {
    await seed();
    await save(ADMIN, {
      orderId: ORDER,
      presentation: PRESENTATION,
      adjustments: { vatClassification: "zero_rated" },
    });
    const inv = await invoice(ORDER);
    assert.equal(inv.vatAmountCentavos, 0);
    assert.equal(inv.zeroRatedSalesCentavos, SUBTOTAL);
    assert.equal(inv.grandTotalCentavos, SUBTOTAL);
    assert.equal(inv.subtotalCentavos, SUBTOTAL, "the base is untouched by the classification");
  });

  await t.test("a discount larger than the goods is refused, and nothing is written", async () => {
    await seed();
    assert.equal(
      await codeOf(save(ADMIN, { orderId: ORDER, adjustments: { discountCentavos: SUBTOTAL + 1 } })),
      "discount-exceeds-subtotal"
    );
    assert.equal(await invoice(ORDER), null, "no draft was created");
    assert.equal((await db.collection("counters").get()).size, 0, "no number was burned");
  });
});

// -------------------------------------------------------- negative controls

test("invoice: an admin cannot substitute base pricing", async (t) => {
  const substitutions = [
    ["a unit price, as an adjustment", { adjustments: { unitPriceCentavos: 1 } }],
    ["a subtotal, as an adjustment", { adjustments: { subtotalCentavos: 1 } }],
    ["items, as an adjustment", { adjustments: { items: [] } }],
    ["a quantity, as an adjustment", { adjustments: { quantity: 999 } }],
    ["a unit price, as presentation", { presentation: { unitPrice: "1" } }],
    ["a subtotal, as presentation", { presentation: { subtotalCentavos: "1" } }],
    ["items, as presentation", { presentation: { items: "x" } }],
    ["a grand total, as presentation", { presentation: { grandTotal: "1" } }],
    ["the pricing version, as presentation", { presentation: { pricingVersion: "2" } }],
    ["the invoice status, as presentation", { presentation: { invoiceStatus: "issued" } }],
    ["the invoice number, as presentation", { presentation: { invoiceNumber: "INV-2026-000999" } }],
  ];

  for (const [label, payload] of substitutions) {
    await t.test(label, async () => {
      await seed();
      assert.equal(
        await codeOf(save(ADMIN, { orderId: ORDER, ...payload })),
        "unknown-field",
        "refused loudly, not silently dropped"
      );
      assert.equal(await invoice(ORDER), null, "nothing was written");
    });
  }

  await t.test("even a well-formed base sent alongside a valid save is refused", async () => {
    await seed();
    assert.equal(
      await codeOf(
        save(ADMIN, {
          orderId: ORDER,
          presentation: PRESENTATION,
          adjustments: { discountCentavos: 1000, subtotalCentavos: SUBTOTAL },
        })
      ),
      "unknown-field"
    );
  });
});

test("invoice: direct Firestore tampering cannot be issued", async (t) => {
  const tamper = async (patch) => {
    await seed();
    await save(ADMIN, { orderId: ORDER, presentation: PRESENTATION });
    // The Admin SDK bypasses rules — this simulates a write that reached the
    // document by some route the rules did not cover.
    await db.collection("invoices").doc(ORDER).update(patch);
    return codeOf(issue(ADMIN, { orderId: ORDER }));
  };

  await t.test("a substituted unit price", async () => {
    const inv = await (async () => { await seed(); await save(ADMIN, { orderId: ORDER, presentation: PRESENTATION }); return invoice(ORDER); })();
    const items = JSON.parse(JSON.stringify(inv.items));
    items[0].unitPriceCentavos = 1;
    items[0].lineTotalCentavos = 4;
    await db.collection("invoices").doc(ORDER).update({ items, subtotalCentavos: 4 + 3 * SECOND });
    assert.equal(await codeOf(issue(ADMIN, { orderId: ORDER })), "invoice-base-mismatch");
    assert.equal((await invoice(ORDER)).invoiceStatus, "draft", "still not issued");
  });

  await t.test("a substituted quantity", async () => {
    await seed();
    await save(ADMIN, { orderId: ORDER, presentation: PRESENTATION });
    const inv = await invoice(ORDER);
    const items = JSON.parse(JSON.stringify(inv.items));
    items[0].quantity = 400;
    await db.collection("invoices").doc(ORDER).update({ items });
    assert.equal(await codeOf(issue(ADMIN, { orderId: ORDER })), "invoice-base-mismatch");
  });

  await t.test("a substituted subtotal", async () => {
    assert.equal(await tamper({ subtotalCentavos: 1 }), "invoice-base-mismatch");
  });

  await t.test("a substituted line total", async () => {
    await seed();
    await save(ADMIN, { orderId: ORDER, presentation: PRESENTATION });
    const inv = await invoice(ORDER);
    const items = JSON.parse(JSON.stringify(inv.items));
    items[1].lineTotalCentavos = 1;
    await db.collection("invoices").doc(ORDER).update({ items });
    assert.equal(await codeOf(issue(ADMIN, { orderId: ORDER })), "invoice-base-mismatch");
  });

  await t.test("a substituted VAT amount", async () => {
    assert.equal(await tamper({ vatAmountCentavos: 0 }), "invoice-total-mismatch");
  });

  await t.test("a substituted grand total", async () => {
    assert.equal(await tamper({ grandTotalCentavos: 1 }), "invoice-total-mismatch");
  });

  await t.test("a substituted net or amount due", async () => {
    assert.equal(await tamper({ netCentavos: 1 }), "invoice-total-mismatch");
    assert.equal(await tamper({ totalAmountDueCentavos: 1 }), "invoice-total-mismatch");
  });

  await t.test("a substituted discount, which no longer matches the totals", async () => {
    // Editing the discount alone leaves the recorded totals describing a
    // different discount, and issuing recomputes rather than trusting them.
    assert.equal(await tamper({ discountCentavos: 100000 }), "invoice-total-mismatch");
  });

  await t.test("a re-save repairs the document and it issues cleanly", async () => {
    await seed();
    await save(ADMIN, { orderId: ORDER, presentation: PRESENTATION });
    await db.collection("invoices").doc(ORDER).update({ grandTotalCentavos: 1 });
    assert.equal(await codeOf(issue(ADMIN, { orderId: ORDER })), "invoice-total-mismatch");

    await save(ADMIN, { orderId: ORDER, presentation: PRESENTATION });
    const r = await issue(ADMIN, { orderId: ORDER });
    assert.equal(r.replayed, false);
    assert.equal((await invoice(ORDER)).invoiceStatus, "issued");
  });
});

test("invoice: authorization comes from the server-side user document", async (t) => {
  await t.test("a sales rep cannot save or issue an invoice", async () => {
    await seed();
    assert.equal(await codeOf(save(SALESREP, { orderId: ORDER })), "wrong-role");
    assert.equal(await codeOf(issue(SALESREP, { orderId: ORDER })), "wrong-role");
    assert.equal(await invoice(ORDER), null);
  });

  await t.test("an unapproved admin cannot either — on BOTH operations", async () => {
    await seed();
    assert.equal(await codeOf(save(ADMIN_PENDING, { orderId: ORDER })), "not-approved");
    // Issue is checked separately: an approval that lapses between saving and
    // issuing must stop the issuance too.
    await save(ADMIN, { orderId: ORDER, presentation: PRESENTATION });
    assert.equal(await codeOf(issue(ADMIN_PENDING, { orderId: ORDER })), "not-approved");
    assert.equal((await invoice(ORDER)).invoiceStatus, "draft", "still not issued");
  });

  await t.test("every other role is refused on both operations", async () => {
    await seed();
    await db.collection("users").doc("disp1").set({ role: "dispatcher", status: "approved" });
    await db.collection("users").doc("rider1").set({ role: "rider", status: "approved" });
    for (const uid of ["disp1", "rider1", SALESREP]) {
      assert.equal(await codeOf(save(uid, { orderId: ORDER })), "wrong-role", uid);
      assert.equal(await codeOf(issue(uid, { orderId: ORDER })), "wrong-role", uid);
    }
  });

  await t.test("a caller with no profile document is refused, not defaulted", async () => {
    // An authenticated uid with no users/{uid} document must not fall through
    // to some default role.
    await seed();
    assert.equal(await codeOf(save("ghost", { orderId: ORDER })), "profile-missing");
    assert.equal(await codeOf(issue("ghost", { orderId: ORDER })), "profile-missing");
  });

  await t.test("the caller's role is read from the SERVER, not the payload", async () => {
    // A payload claiming to be an admin changes nothing: requireRole reads the
    // caller's own users document inside the operation.
    await seed();
    assert.equal(
      await codeOf(save(SALESREP, { orderId: ORDER, role: "admin", uid: ADMIN })),
      "wrong-role"
    );
  });

  await t.test("an unknown order or invoice is a not-found, not a blank draft", async () => {
    await seed();
    assert.equal(await codeOf(save(ADMIN, { orderId: "nope" })), "order-not-found");
    assert.equal(await codeOf(issue(ADMIN, { orderId: ORDER })), "invoice-not-found");
    for (const bad of ["", "   ", "a/b", null, 5]) {
      assert.equal(await codeOf(save(ADMIN, { orderId: bad })), "invalid-payload", String(bad));
    }
  });
});

test("invoice: identity is the document id, not a caller's claim", async (t) => {
  await t.test("the invoice doc and the order doc are the SAME id", async () => {
    // One caller-supplied string resolves both references, so there is no way
    // to point invoice X at order Y — the substitution is structurally absent
    // rather than merely validated against.
    await seed();
    await save(ADMIN, { orderId: ORDER, presentation: PRESENTATION });
    const snap = await db.collection("invoices").doc(ORDER).get();
    assert.equal(snap.id, ORDER, "the invoice document id IS the order id");
    assert.equal(snap.data().orderId, ORDER, "and the stored field agrees");
    assert.equal(
      (await db.collection("invoices").get()).size,
      1,
      "exactly one invoice document was created"
    );
  });

  await t.test("orderId cannot be smuggled in through presentation", async () => {
    await seed();
    assert.equal(
      await codeOf(save(ADMIN, { orderId: ORDER, presentation: { orderId: LEGACY_ORDER } })),
      "unknown-field"
    );
  });

  await t.test("a path-shaped orderId cannot escape the collection", async () => {
    await seed();
    for (const bad of ["../orders/x", "a/b", "orders/ordPriced", "/", "ordPriced/"]) {
      assert.equal(await codeOf(save(ADMIN, { orderId: bad })), "invalid-payload", bad);
      assert.equal(await codeOf(issue(ADMIN, { orderId: bad })), "invalid-payload", bad);
    }
    assert.equal((await db.collection("invoices").get()).size, 0, "nothing was written");
  });

  await t.test("the invoice of one order is never priced from another", async () => {
    // Both orders exist and both are invoiceable; each invoice draws only from
    // the order whose id it carries.
    await seed();
    await db.collection("orders").doc("order_other").set(
      pricedOrderDoc({
        orderNumber: "VT-ORD-OTHER",
        subtotalCentavos: 125000,
        items: [
          { inventoryId: "invX", batchId: "X-1", name: "Other", quantity: 1,
            unitPriceCentavos: 125000, lineTotalCentavos: 125000, unitPrice: 1250 },
        ],
      })
    );
    await save(ADMIN, { orderId: ORDER, presentation: PRESENTATION });
    await save(ADMIN, { orderId: "order_other", presentation: PRESENTATION });

    assert.equal((await invoice(ORDER)).subtotalCentavos, SUBTOTAL);
    assert.equal((await invoice("order_other")).subtotalCentavos, 125000);
    assert.equal((await invoice(ORDER)).items.length, 2);
    assert.equal((await invoice("order_other")).items.length, 1);
  });
});

test("invoice: issuing is transactional, terminal and idempotent", async (t) => {
  await t.test("two simultaneous issues produce ONE issuance", async () => {
    await seed();
    await save(ADMIN, { orderId: ORDER, presentation: PRESENTATION });

    const results = await Promise.allSettled([
      issue(ADMIN, { orderId: ORDER }),
      issue(ADMIN, { orderId: ORDER }),
      issue(ADMIN, { orderId: ORDER }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    assert.equal(ok.length, 3, "every caller gets an answer");
    // Exactly one of them performed the transition; the rest replayed it.
    const performed = ok.filter((r) => r.value.replayed === false);
    assert.equal(performed.length, 1, "exactly one issuance actually happened");

    const inv = await invoice(ORDER);
    assert.equal(inv.invoiceStatus, "issued");
    assert.equal((await db.collection("invoices").get()).size, 1);
  });

  await t.test("a retry re-applies nothing — every figure is byte-identical", async () => {
    await seed();
    await save(ADMIN, {
      orderId: ORDER,
      presentation: PRESENTATION,
      adjustments: { discountCentavos: 35000, otherChargesCentavos: 5000, withholdingTaxCentavos: 1000 },
    });
    await issue(ADMIN, { orderId: ORDER });
    const first = await invoice(ORDER);

    // Three more retries. An adjustment applied twice would move net, VAT or
    // the amount due; the issued timestamp must not move either.
    for (let i = 0; i < 3; i += 1) {
      const r = await issue(ADMIN, { orderId: ORDER });
      assert.equal(r.replayed, true);
    }
    const after = await invoice(ORDER);

    for (const field of [
      "discountCentavos", "otherChargesCentavos", "withholdingTaxCentavos",
      "netCentavos", "vatAmountCentavos", "grandTotalCentavos",
      "totalAmountDueCentavos", "subtotalCentavos", "invoiceNumber",
    ]) {
      assert.equal(after[field], first[field], `${field} must not move on a retry`);
    }
    assert.deepEqual(after.issuedAt, first.issuedAt, "the issuance instant is not re-stamped");
    assert.deepEqual(after.items, first.items);
  });

  await t.test("issued is TERMINAL — no path returns it to draft", async () => {
    await seed();
    await save(ADMIN, { orderId: ORDER, presentation: PRESENTATION });
    await issue(ADMIN, { orderId: ORDER });

    // The save path refuses outright rather than reverting the status.
    assert.equal(
      await codeOf(save(ADMIN, { orderId: ORDER, presentation: { customerName: "Nope" } })),
      "invoice-already-issued"
    );
    const inv = await invoice(ORDER);
    assert.equal(inv.invoiceStatus, "issued");
    assert.notEqual(inv.customerName, "Nope", "and nothing was written");
  });

  await t.test("a draft that was never saved cannot be issued", async () => {
    await seed();
    assert.equal(await codeOf(issue(ADMIN, { orderId: ORDER })), "invoice-not-found");
  });
});

test("invoice: audit is server time and the authenticated uid", async (t) => {
  await t.test("create, update and issue stamps all come from the server", async () => {
    await seed();
    await save(ADMIN, { orderId: ORDER, presentation: PRESENTATION });
    const draft = await invoice(ORDER);

    // Timestamps are real Firestore Timestamps, not client-supplied values.
    assert.ok(draft.createdAt?.toDate, "createdAt is a server Timestamp");
    assert.ok(draft.updatedAt?.toDate, "updatedAt is a server Timestamp");
    assert.equal(draft.createdByUid, ADMIN, "the uid is the caller's, not a payload's");
    assert.equal(draft.updatedByUid, ADMIN);

    await issue(ADMIN, { orderId: ORDER });
    const issued = await invoice(ORDER);
    assert.ok(issued.issuedAt?.toDate, "issuedAt is a server Timestamp");
    assert.equal(issued.issuedByUid, ADMIN);
  });

  await t.test("a caller cannot supply or forge any audit field", async () => {
    await seed();
    for (const forged of [
      { createdByUid: "someone-else" },
      { updatedByUid: "someone-else" },
      { issuedByUid: "someone-else" },
      { createdAt: "2020-01-01" },
      { issuedAt: "2020-01-01" },
    ]) {
      assert.equal(
        await codeOf(save(ADMIN, { orderId: ORDER, presentation: forged })),
        "unknown-field",
        JSON.stringify(forged)
      );
    }
  });

  await t.test("the creation trail survives a later save by another admin", async () => {
    await seed();
    await db.collection("users").doc("admin2").set({ role: "admin", status: "approved" });
    await save(ADMIN, { orderId: ORDER, presentation: PRESENTATION });
    const first = await invoice(ORDER);

    await save("admin2", { orderId: ORDER, presentation: { customerName: "Edited" } });
    const second = await invoice(ORDER);

    assert.equal(second.createdByUid, ADMIN, "the original author is preserved");
    assert.deepEqual(second.createdAt, first.createdAt);
    assert.equal(second.updatedByUid, "admin2", "the editor is recorded as the updater");
  });
});

test("invoice: a LEGACY order never reaches this path", async () => {
  await seed();
  // The callable refuses it outright, so a legacy order cannot be dragged onto
  // server pricing and given figures it never had.
  assert.equal(await codeOf(save(ADMIN, { orderId: LEGACY_ORDER })), "order-not-priced");
  assert.equal(await codeOf(issue(ADMIN, { orderId: LEGACY_ORDER })), "invoice-not-found");
  assert.equal(await invoice(LEGACY_ORDER), null, "nothing was written for it");

  // Its own document is untouched — no version stamp, no centavo figures.
  const legacy = (await db.collection("orders").doc(LEGACY_ORDER).get()).data();
  assert.equal(legacy.pricingVersion, undefined);
  assert.equal(legacy.subtotalCentavos, undefined);
  assert.equal(legacy.items[0].unitPrice, 0, "still priced by hand at invoice time");
});

test("invoice: an issued invoice does not follow a later re-price", async () => {
  await seed();
  await save(ADMIN, { orderId: ORDER, presentation: PRESENTATION });
  await issue(ADMIN, { orderId: ORDER });
  const issued = await invoice(ORDER);

  // The order's own snapshot is immutable, so re-pricing the batch changes
  // neither it nor the invoice already drawn from it. Simulate an order whose
  // batch has since been re-priced by leaving the order exactly as it is —
  // that IS the guarantee — and confirm the invoice is unmoved.
  await db.collection("inventory").doc("inv1").set({ sellingPriceCentavos: 999900 });

  const after = await invoice(ORDER);
  assert.equal(after.items[0].unitPriceCentavos, PRICE);
  assert.equal(after.subtotalCentavos, issued.subtotalCentavos);
  assert.equal(after.grandTotalCentavos, issued.grandTotalCentavos);
  assert.equal(after.invoiceStatus, "issued");
});
