import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServiceLoader, createStore, installStore } from "./serviceHarness.js";

/**
 * Document identity across every remaining collection.
 *
 * The rule: a Firestore document's ID is its only identity, and no field STORED
 * INSIDE the document may replace it. A mapper that writes `{ id: d.id,
 * ...d.data() }` spreads the data last, so a stored `id` wins — and every later
 * write aimed at that value lands on a different document.
 *
 * `orderIdentity.test.js` already covers `orders`. This covers the rest:
 * alerts, invoices, users and vaccineTypes. It executes the real service
 * modules against the in-memory Firestore stand-in, so each case proves
 * BEHAVIOUR — the write really is re-aimed — rather than asserting on source
 * text. The source-shape checks at the end are a second, cheaper net.
 */

const loader = createServiceLoader();
const alertService = await loader.load("alertService.js");
const invoiceService = await loader.load("invoiceService.js");
const userService = await loader.load("userService.js");
const vaccineService = await loader.load("vaccineService.js");

const VICTIM = "VICTIM-DOC-ID";

/** Where a write actually landed, by collection. (`col` is the harness's key.) */
const writesTo = (store, collectionName) =>
  store.writes.filter((w) => w.col === collectionName).map((w) => w.id);

// ------------------------------------------------------------------ alerts

test("alerts: a stored `id` cannot redirect resolve or mark-read", async (t) => {
  // Reachable by a rider. The alerts rule lets a rider create its own
  // `route_deviation` incident and constrains type/riderId/severity/status/
  // timestamps — but not EXTRA fields, so a modified client can include an
  // `id`. An admin then clicks Resolve on that row.
  const seed = () =>
    installStore(
      createStore({
        alerts: {
          realAlertDoc: {
            id: VICTIM, // the attack
            type: "route_deviation",
            riderId: "riderUid123",
            severity: "critical",
            status: "active",
            read: false,
            title: "Route Deviation Detected",
          },
          [VICTIM]: {
            type: "cold_chain",
            severity: "critical",
            status: "active",
            read: false,
            title: "Someone else's critical alert",
          },
        },
      })
    );

  await t.test("subscribeAllAlerts reports the DOCUMENT id", async () => {
    seed();
    let rows = [];
    alertService.subscribeAllAlerts((r) => { rows = r; });
    const forged = rows.find((r) => r.title === "Route Deviation Detected");
    assert.equal(forged.id, "realAlertDoc", "the document id must win over the stored field");
    assert.notEqual(forged.id, VICTIM);
  });

  await t.test("subscribeActiveAlerts reports the DOCUMENT id", async () => {
    seed();
    let rows = [];
    alertService.subscribeActiveAlerts((r) => { rows = r; });
    const forged = rows.find((r) => r.title === "Route Deviation Detected");
    assert.equal(forged.id, "realAlertDoc");
  });

  await t.test("resolving the row closes THAT alert, not the victim", async () => {
    const store = seed();
    let rows = [];
    alertService.subscribeAllAlerts((r) => { rows = r; });
    const forged = rows.find((r) => r.title === "Route Deviation Detected");

    // Exactly what Admin Alerts does: resolve(selectedAlert.id).
    await alertService.resolveAlert(forged.id);

    assert.deepEqual(writesTo(store, "alerts"), ["realAlertDoc"]);
    assert.equal(store.collections.alerts.realAlertDoc.data.status, "resolved");
    assert.equal(
      store.collections.alerts[VICTIM].data.status,
      "active",
      "the unrelated critical alert must be untouched"
    );
  });

  await t.test("mark-read cannot be redirected either", async () => {
    const store = seed();
    let rows = [];
    alertService.subscribeAllAlerts((r) => { rows = r; });
    const forged = rows.find((r) => r.title === "Route Deviation Detected");

    await alertService.markAlertRead(forged.id);
    assert.deepEqual(writesTo(store, "alerts"), ["realAlertDoc"]);
    assert.equal(store.collections.alerts[VICTIM].data.read, false);
  });

  await t.test("two alerts claiming one id still render as distinct rows", async () => {
    // React keys come from the same value; if the stored field won, two rows
    // would share a key and React would reconcile them as one.
    installStore(
      createStore({
        alerts: {
          alertA: { id: "SAME", status: "active", title: "A" },
          alertB: { id: "SAME", status: "active", title: "B" },
        },
      })
    );
    let rows = [];
    alertService.subscribeAllAlerts((r) => { rows = r; });
    const ids = rows.map((r) => r.id).sort();
    assert.deepEqual(ids, ["alertA", "alertB"], "keys must be unique document ids");
    assert.equal(new Set(ids).size, 2);
  });
});

// ---------------------------------------------------------------- invoices

test("invoices: a stored `id` cannot redirect a draft save or an issuance", async (t) => {
  const seed = () =>
    installStore(
      createStore({
        invoices: {
          orderAbc: {
            id: VICTIM, // the attack
            orderId: "orderAbc",
            invoiceNumber: "INV-2026-000001",
            invoiceStatus: "draft",
            subtotal: 800,
            grandTotal: 896,
            items: [{ itemDescription: "X", quantity: 8, unitPrice: 100 }],
          },
          [VICTIM]: {
            orderId: "someOtherOrder",
            invoiceNumber: "INV-2026-000999",
            invoiceStatus: "draft",
            subtotal: 5000,
            grandTotal: 5600,
            items: [{ itemDescription: "Y", quantity: 1, unitPrice: 5000 }],
          },
        },
      })
    );

  await t.test("getInvoiceByOrderId returns the DOCUMENT id", async () => {
    seed();
    const invoice = await invoiceService.getInvoiceByOrderId("orderAbc");
    assert.equal(invoice.id, "orderAbc", "the document id must win over the stored field");
    assert.notEqual(invoice.id, VICTIM);
  });

  await t.test("issuing the loaded invoice issues THAT one", async () => {
    // InvoiceEditor calls issueInvoice(invoice.id). A redirected id would have
    // issued — and permanently locked — a different clinic's invoice.
    const store = seed();
    const invoice = await invoiceService.getInvoiceByOrderId("orderAbc");

    await invoiceService.issueInvoice(invoice.id, { uid: "admin1", email: "a@x.com" });

    assert.equal(store.collections.invoices.orderAbc.data.invoiceStatus, "issued");
    assert.equal(
      store.collections.invoices[VICTIM].data.invoiceStatus,
      "draft",
      "the other invoice must not have been issued"
    );
  });

  await t.test("saving a draft writes to THAT invoice", async () => {
    const store = seed();
    const invoice = await invoiceService.getInvoiceByOrderId("orderAbc");

    await invoiceService.updateInvoiceDraft(
      invoice.id,
      { items: [{ itemDescription: "X", quantity: 8, unitPrice: 100 }], subtotal: 800, grandTotal: 896, notes: "edited" },
      { uid: "admin1", email: "a@x.com" }
    );

    assert.equal(store.collections.invoices.orderAbc.data.notes, "edited");
    assert.equal(store.collections.invoices[VICTIM].data.notes, undefined);
  });

  await t.test("the queue row carries the document id too", async () => {
    const store = installStore(
      createStore({
        orders: { orderAbc: { orderNumber: "VT-1", status: "delivered", createdAt: null } },
        invoices: {
          orderAbc: { id: VICTIM, orderId: "orderAbc", invoiceStatus: "draft", invoiceNumber: "INV-2026-000001", grandTotal: 896, items: [{ quantity: 1, unitPrice: 1 }] },
        },
      })
    );
    let rows = [];
    invoiceService.subscribeInvoiceQueue((r) => { rows = r; });
    const row = rows.find((r) => r.orderId === "orderAbc");
    assert.equal(row.invoiceId, "orderAbc", "queue rows must carry the document id");
    assert.notEqual(row.invoiceId, VICTIM);
    assert.ok(store);
  });
});

// ------------------------------------------------------------------- users

test("users: a stored `id` cannot shadow the profile's identity", async () => {
  // getUserProfile's `.id` is display-only today — every caller writes with the
  // AUTH uid. It is corrected anyway: `users` is the collection where identity
  // decides access, and a shadowable id sitting in the returned object is a
  // trap for the next caller who reaches for `profile.id`.
  installStore(
    createStore({
      users: {
        realUserUid: { id: VICTIM, uid: VICTIM, role: "salesrep", status: "approved", name: "Real" },
        [VICTIM]: { role: "admin", status: "approved", name: "Victim" },
      },
    })
  );
  const profile = await userService.getUserProfile("realUserUid");
  assert.equal(profile.id, "realUserUid", "the document id must win");
  assert.notEqual(profile.id, VICTIM);
  assert.equal(profile.role, "salesrep", "other stored fields still come through");
});

test("users: the admin roster reports document ids", async () => {
  const store = installStore(
    createStore({
      users: {
        realUserUid: { id: VICTIM, role: "rider", status: "pending", name: "A Rider" },
        [VICTIM]: { role: "admin", status: "approved", name: "An Admin" },
      },
    })
  );
  let rows = [];
  userService.subscribeUsers((r) => { rows = r; });
  const rider = rows.find((r) => r.name === "A Rider");
  assert.equal(rider.id, "realUserUid");

  // Admin Settings turns that into the uid it approves and re-roles.
  await userService.updateUserStatus(rider.id, "approved");
  assert.equal(store.collections.users.realUserUid.data.status, "approved");
  assert.equal(store.collections.users[VICTIM].data.status, "approved", "seeded approved, unchanged");
  assert.equal(store.collections.users[VICTIM].data.role, "admin", "victim role untouched");
});

// ------------------------------------------------------------ vaccineTypes

test("vaccineTypes: list keys are document ids", async () => {
  // Used as a React key in the Add Vaccine dropdown. Two types claiming one id
  // would collapse into a single option.
  installStore(
    createStore({
      vaccineTypes: {
        typeDocA: { id: "SAME", name: "mRNA" },
        typeDocB: { id: "SAME", name: "Viral Vector" },
      },
    })
  );
  const types = await vaccineService.getVaccineTypes();
  const ids = types.map((t) => t.id).sort();
  assert.deepEqual(ids, ["typeDocA", "typeDocB"]);
  assert.equal(new Set(ids).size, 2, "React keys must be unique");
});

// -------------------------------------------------- source-shape backstop

test("every service mapper spreads data BEFORE assigning the document id", () => {
  // A cheap net over the whole directory, so a mapper added later cannot
  // reintroduce the pattern without this failing. Comments are stripped: the
  // fixes carry comments quoting the OLD shape to explain what went wrong.
  const dir = new URL("../src/services/", import.meta.url);
  const files = [
    "alertService.js", "cargoLoadingService.js", "clinicService.js",
    "deliveryService.js", "inventoryService.js", "invoiceService.js",
    "orderService.js", "riderService.js", "userService.js", "vaccineService.js",
  ];

  for (const file of files) {
    const src = readFileSync(new URL(file, dir), "utf8")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    // `{ id: <x>.id, ...` and `{ id: <x>.id,\n ...` both spread data last.
    const offenders = [...src.matchAll(/\{\s*(?:id|uid):\s*\w+\.id,\s*\.\.\./g)];
    assert.deepEqual(
      offenders.map((m) => m[0].replace(/\s+/g, " ")),
      [],
      `${file}: document id must be assigned AFTER the data spread`
    );
  }
});
