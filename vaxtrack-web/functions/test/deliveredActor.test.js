"use strict";

/**
 * Server half of "Submit Proof & Complete Delivery".
 *
 * The Rider app now records both evidence photos and then, in the same action,
 * calls markOrderDeliveredWithInventoryConsumption. These cases pin what the
 * server guarantees regardless of what any client does:
 *
 *   - completion requires RECORDED proof and invoice evidence (the order's
 *     metadata, written through the rules' one-shot evidence submissions) by
 *     the completing rider — a Storage file or a bare legacy URL is not enough;
 *   - only the current assigned, approved rider can complete; dispatchers and
 *     Med Reps cannot;
 *   - a repeated call is a replay: stock is consumed once and the status
 *     changes once, so the trigger records exactly one Delivered event;
 *   - attribution — statusUpdatedByUid, statusUpdatedByEmail and the Delivered
 *     event's actorUid — names the rider, while the earlier dispatch event
 *     still names the dispatcher;
 *   - nothing else on the order moves (price, VAT, discount, destination,
 *     proof, invoice).
 *
 * The callable and the status-history functions are the real ones. Storage is
 * a small in-memory Firestore rather than the emulator: completion runs a
 * transaction, and an extra transaction in the parallel emulator suite
 * destabilised its timing-sensitive "five simultaneous submits" case. The
 * emulator suite (integration/operations.test.js) still exercises delivery
 * against real Firestore.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { markOrderDeliveredWithInventoryConsumption } = require("../src/operations");
const { deriveStatusEvent, recordStatusEvent } = require("../src/statusEvents");
const { ALLOCATION_VERSION } = require("../src/policy");
const { deliveryEvidenceProblem, canonicalProofPath, canonicalInvoicePath } = require("../src/deliveryEvidence");

// ------------------------------------------------------------ in-memory store

// Each server timestamp is a distinct marker, so a re-stamp is visible as a change.
let stamps = 0;
const serverTime = () => ({ serverTimestamp: ++stamps });
const isServerTime = (v) => typeof v?.serverTimestamp === "number";
const DELETE = { delete: true };
const FieldValue = { serverTimestamp: serverTime, delete: () => DELETE };

/** Doc get + transactions whose writes apply only when the callback resolves
 * (a throw writes nothing), sub-collections, create/update and field deletes. */
function fakeDb(seed) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, structuredClone(v)]));
  const snap = (p) => {
    const data = store.has(p) ? structuredClone(store.get(p)) : undefined;
    return { exists: store.has(p), data: () => data, get: (field) => (data ? data[field] : undefined) };
  };
  const ref = (p) => ({
    path: p,
    get: async () => snap(p),
    collection: (name) => ({ doc: (id) => ref(`${p}/${name}/${id}`) }),
  });
  const apply = (p, data) => {
    const next = { ...store.get(p) };
    for (const [k, v] of Object.entries(data)) {
      if (v === DELETE) delete next[k];
      else next[k] = v;
    }
    store.set(p, next);
  };
  return {
    store,
    collection: (name) => ({ doc: (id) => ref(`${name}/${id}`) }),
    async runTransaction(fn) {
      const writes = [];
      const tx = {
        get: async (r) => snap(r.path),
        update: (r, data) => writes.push(["update", r.path, data]),
        create: (r, data) => writes.push(["create", r.path, data]),
      };
      const result = await fn(tx);
      for (const [kind, p, data] of writes) {
        if (kind === "create") {
          if (store.has(p)) throw new Error(`create of existing ${p}`);
          store.set(p, structuredClone(data));
        } else {
          if (!store.has(p)) throw new Error(`update of missing ${p}`);
          apply(p, data);
        }
      }
      return result;
    },
    /** A plain client-style update (the dispatcher's write, the rider's evidence). */
    update(p, data) {
      apply(p, data);
    },
  };
}

// ------------------------------------------------------------ fixture

const RIDER = "rider1";
const RIDER_EMAIL = "rider.qa2@vaxtrack-staging.com";
const OTHER_RIDER = "rider2";
const DISPATCHER = "disp1";
const DISPATCHER_EMAIL = "dispatcher@vaxtrack-staging.com";
const MED_REP = "rep1";

// Everything a completion must leave alone: price snapshot, VAT convention,
// discount and destination snapshot.
const UNTOUCHABLE = {
  orderNumber: "VT-ORD-1",
  createdByUid: MED_REP,
  pricingVersion: 1,
  subtotalCentavos: 250000,
  priceIsVatInclusive: false,
  vatClassification: "vatable",
  discountCentavos: 1000,
  items: [{ inventoryId: "inv1", quantity: 2, unitPriceCentavos: 125000, lineTotalCentavos: 250000 }],
  doctorId: "doc1",
  doctorName: "Dr. Ana Reyes",
  destinationType: "clinic",
  destinationName: "Laguna Clinic",
  deliveryAddress: "1 National Highway",
  clinicDocId: "clinic1",
  clinicLat: 14.3,
  clinicLng: 121.1,
  // The authoritative destination snapshot the delivery geofence reads.
  destinationLat: 14.3,
  destinationLng: 121.1,
  destinationGeofenceRadiusM: 300,
  destinationLocationVerified: true,
};

// Loading, assigned to the rider; the next step is the dispatcher's dispatch.
const loading = (over = {}) => ({
  ...UNTOUCHABLE,
  status: "loading",
  assignedRiderId: RIDER,
  statusUpdatedByUid: DISPATCHER,
  statusUpdatedByEmail: DISPATCHER_EMAIL,
  ...over,
});

/** A fresh, accurate, active location exactly at the destination. */
const atClinic = () => ({
  riderUid: RIDER, trackingState: "active", latitude: 14.3, longitude: 121.1, accuracyMeters: 8,
  capturedAt: new Date(), updatedAt: new Date(),
});

function fixture() {
  return fakeDb({
    [`users/${RIDER}`]: { role: "rider", status: "approved", email: RIDER_EMAIL },
    [`users/${OTHER_RIDER}`]: { role: "rider", status: "approved" },
    [`users/${DISPATCHER}`]: { role: "dispatcher", status: "approved" },
    [`users/${MED_REP}`]: { role: "salesrep", status: "approved" },
    "orders/legacy": loading(),
    "orders/reserved": loading({ allocationVersion: ALLOCATION_VERSION }),
    "inventoryReservations/reserved": { status: "reserved", items: [{ inventoryId: "inv1", quantity: 2 }] },
    "inventory/inv1": { quantity: 10, reservedQuantity: 2, sellingPriceCentavos: 125000 },
    // The Rider is at the clinic with a fresh, accurate fix (deliveryGeofence.js).
    [`riderLocations/${RIDER}`]: atClinic(),
  });
}

let clock = 0;
/** What recordOrderStatusEvent does for one document write. */
async function trigger(db, orderId, before, eventId) {
  const event = deriveStatusEvent({ before, after: db.store.get(`orders/${orderId}`) });
  if (!event) return null;
  clock += 1;
  await recordStatusEvent({ db, orderId, eventId, event, at: `t${clock}` });
  return db.store.get(`orders/${orderId}/statusEvents/${eventId}`);
}

/** The dispatcher's finalize write (cargoLoadingService), then its event. */
async function dispatch(db, orderId) {
  const before = db.store.get(`orders/${orderId}`);
  db.update(`orders/${orderId}`, {
    status: "in_transit",
    dispatchedAt: serverTime(),
    startedAt: serverTime(),
    statusUpdatedAt: serverTime(),
    statusUpdatedByUid: DISPATCHER,
    statusUpdatedByEmail: DISPATCHER_EMAIL,
    updatedAt: serverTime(),
  });
  return trigger(db, orderId, before, "evt-dispatch");
}

/** The two one-shot evidence writes ProofService makes (the rules' shapes). */
const proofFields = (orderId, uid = RIDER) => ({
  proofOfDeliveryUrl: `https://storage/${orderId}/proof.jpg`,
  proofOfDeliveryPath: canonicalProofPath(orderId),
  proofRecipientName: "Maria Santos",
  proofSubmittedAt: serverTime(),
  proofSubmittedByUid: uid,
});
const invoiceFields = (orderId, uid = RIDER) => ({
  invoiceUrl: `https://storage/${orderId}/invoice.jpg`,
  invoicePath: canonicalInvoicePath(orderId),
  invoiceSubmittedAt: serverTime(),
  invoiceSubmittedByUid: uid,
});
function recordEvidence(db, orderId, { proof = true, invoice = true, uid = RIDER } = {}) {
  if (proof) db.update(`orders/${orderId}`, { ...proofFields(orderId, uid), updatedAt: serverTime() });
  if (invoice) db.update(`orders/${orderId}`, { ...invoiceFields(orderId, uid), updatedAt: serverTime() });
}

/** The real completion callable, then its event (if the status changed). */
async function complete(db, orderId, opts = {}) {
  const uid = opts.uid ?? RIDER;
  // "email" in opts, not a default: an explicit undefined must reach the callable.
  const email = "email" in opts ? opts.email : RIDER_EMAIL;
  const before = db.store.get(`orders/${orderId}`);
  const result = await markOrderDeliveredWithInventoryConsumption({ db, FieldValue, uid, email, orderId });
  const event = await trigger(db, orderId, before, opts.eventId ?? "evt-complete");
  return { result, event };
}

const events = (db, orderId) =>
  [...db.store.keys()].filter((k) => k.startsWith(`orders/${orderId}/statusEvents/`)).map((k) => db.store.get(k));

const codeOf = async (p) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e.code;
  }
};

/** A ready-to-complete order: dispatched, both photos recorded. */
async function ready(orderId = "reserved") {
  const db = fixture();
  await dispatch(db, orderId);
  recordEvidence(db, orderId);
  return db;
}

// ------------------------------------------------------------ evidence rule (pure)

test("the evidence rule accepts only recorded, canonical evidence from the completing rider", () => {
  const id = "o1";
  const full = { ...proofFields(id), ...invoiceFields(id) };
  assert.equal(deliveryEvidenceProblem(full, id, RIDER), null);

  const cases = [
    ["no evidence at all", {}, "proof-missing"],
    ["invoice only", invoiceFields(id), "proof-missing"],
    ["proof only", proofFields(id), "invoice-missing"],
    // A Storage object with no recorded metadata is not evidence.
    ["proof URL+path but never submitted", { ...full, proofSubmittedAt: undefined }, "proof-missing"],
    ["invoice URL+path but never submitted", { ...full, invoiceSubmittedAt: null }, "invoice-missing"],
    // The removed manual-link fallback: a bare URL with no Storage path.
    ["legacy bare proof URL", { ...full, proofOfDeliveryPath: undefined }, "proof-missing"],
    ["another order's proof object", { ...full, proofOfDeliveryPath: canonicalProofPath("other") }, "proof-missing"],
    ["non-canonical invoice name", { ...full, invoicePath: `invoices/${id}/invoice-2.jpg` }, "invoice-missing"],
    ["blank recipient", { ...full, proofRecipientName: "  " }, "proof-missing"],
    ["blank proof URL", { ...full, proofOfDeliveryUrl: "" }, "proof-missing"],
    ["proof recorded by another rider", { ...full, proofSubmittedByUid: OTHER_RIDER }, "evidence-not-yours"],
    ["invoice recorded by another rider", { ...full, invoiceSubmittedByUid: OTHER_RIDER }, "evidence-not-yours"],
  ];
  for (const [name, order, code] of cases) {
    assert.equal(deliveryEvidenceProblem(order, id, RIDER)?.code ?? null, code, name);
  }
});

// ------------------------------------------------------------ the completion

test("1/10/11/12 recorded proof + invoice: delivered, stock consumed once, one Delivered event, Rider is the actor", async () => {
  for (const orderId of ["legacy", "reserved"]) {
    const db = fixture();
    const dispatchEvent = await dispatch(db, orderId);
    assert.equal(dispatchEvent.actorUid, DISPATCHER, orderId);
    recordEvidence(db, orderId);
    const dispatchedAt = db.store.get(`orders/${orderId}`).statusUpdatedAt;

    const { result, event } = await complete(db, orderId);
    assert.equal(result.status, "delivered", orderId);
    assert.equal(result.replayed, false, orderId);

    const order = db.store.get(`orders/${orderId}`);
    assert.equal(order.status, "delivered", orderId);
    // Latest status metadata names the rider — uid and the Activity email.
    assert.equal(order.statusUpdatedByUid, RIDER, orderId);
    assert.equal(order.statusUpdatedByEmail, RIDER_EMAIL, orderId);
    assert.ok(isServerTime(order.statusUpdatedAt), orderId);
    assert.notDeepEqual(order.statusUpdatedAt, dispatchedAt, orderId);
    // The Delivered event names the rider; the dispatch event still the dispatcher.
    assert.deepEqual(
      { from: event.from, to: event.to, actorUid: event.actorUid, riderId: event.riderId },
      { from: "in_transit", to: "delivered", actorUid: RIDER, riderId: RIDER },
      orderId
    );
    assert.equal(db.store.get(`orders/${orderId}/statusEvents/evt-dispatch`).actorUid, DISPATCHER, orderId);
    assert.equal(events(db, orderId).filter((e) => e.to === "delivered").length, 1, orderId);
  }
  // The reserved order's stock is consumed exactly once, by the rider.
  const db = await ready("reserved");
  await complete(db, "reserved");
  assert.deepEqual(db.store.get("inventory/inv1"), { quantity: 8, reservedQuantity: 0, sellingPriceCentavos: 125000 });
  assert.equal(db.store.get("orders/reserved").consumedByUid, RIDER);
  assert.equal(db.store.get("inventoryReservations/reserved").settledByUid, RIDER);
});

test("9/10/11 a duplicate submission is a replay: no second consumption, no second event", async () => {
  const db = await ready("reserved");
  await complete(db, "reserved", { eventId: "evt-1" });
  const orderAfterFirst = structuredClone(db.store.get("orders/reserved"));
  const inventoryAfterFirst = structuredClone(db.store.get("inventory/inv1"));

  for (const eventId of ["evt-2", "evt-3"]) {
    const { result, event } = await complete(db, "reserved", { eventId });
    assert.equal(result.replayed, true, eventId);
    assert.equal(event, null, `${eventId}: no status change, so no history entry`);
  }
  assert.deepEqual(db.store.get("orders/reserved"), orderAfterFirst, "order untouched by replays");
  assert.deepEqual(db.store.get("inventory/inv1"), inventoryAfterFirst, "stock consumed exactly once");
  assert.equal(events(db, "reserved").filter((e) => e.to === "delivered").length, 1);
});

test("6 missing proof or missing invoice prevents completion — nothing is written", async () => {
  for (const [label, evidence, code] of [
    ["neither photo", { proof: false, invoice: false }, "proof-missing"],
    ["only the invoice", { proof: false, invoice: true }, "proof-missing"],
    ["only the proof", { proof: true, invoice: false }, "invoice-missing"],
  ]) {
    const db = fixture();
    await dispatch(db, "reserved");
    recordEvidence(db, "reserved", evidence);
    const before = structuredClone(db.store.get("orders/reserved"));
    const stock = structuredClone(db.store.get("inventory/inv1"));
    assert.equal(await codeOf(complete(db, "reserved")), code, label);
    assert.deepEqual(db.store.get("orders/reserved"), before, `${label}: order unchanged`);
    assert.deepEqual(db.store.get("inventory/inv1"), stock, `${label}: no stock moved`);
    assert.equal(db.store.get("inventoryReservations/reserved").status, "reserved", label);
    assert.equal(events(db, "reserved").some((e) => e.to === "delivered"), false, label);
  }
});

test("6 a legacy order is not completed merely because an old file or bare URL exists", async () => {
  const db = fixture();
  await dispatch(db, "legacy");
  // The removed manual-link fallback: URLs with no Storage path and no
  // one-shot submission markers.
  db.update("orders/legacy", {
    proofOfDeliveryUrl: "https://example.com/proof.png",
    invoiceUrl: "https://example.com/invoice.png",
  });
  assert.equal(await codeOf(complete(db, "legacy")), "proof-missing");
  assert.equal(db.store.get("orders/legacy").status, "in_transit");
});

test("7 an unassigned rider is denied, even with complete evidence", async () => {
  const db = await ready("reserved");
  const before = structuredClone(db.store.get("orders/reserved"));
  assert.equal(await codeOf(complete(db, "reserved", { uid: OTHER_RIDER, email: "r2@x.com" })), "not-assigned-rider");
  assert.deepEqual(db.store.get("orders/reserved"), before);
});

test("8 the dispatcher and the Med Rep are denied", async () => {
  const db = await ready("reserved");
  const before = structuredClone(db.store.get("orders/reserved"));
  assert.equal(await codeOf(complete(db, "reserved", { uid: DISPATCHER, email: DISPATCHER_EMAIL })), "wrong-role");
  assert.equal(await codeOf(complete(db, "reserved", { uid: MED_REP, email: "rep@x.com" })), "wrong-role");
  assert.deepEqual(db.store.get("orders/reserved"), before);
  assert.equal(events(db, "reserved").some((e) => e.to === "delivered"), false);
});

test("a rider assigned after another rider recorded the evidence cannot complete on it", async () => {
  const db = fixture();
  await dispatch(db, "reserved");
  recordEvidence(db, "reserved", { uid: OTHER_RIDER });
  assert.equal(await codeOf(complete(db, "reserved")), "evidence-not-yours");
  assert.equal(db.store.get("orders/reserved").status, "in_transit");
});

test("a rider token without an email clears the stale attribution instead of keeping the dispatcher's", async () => {
  for (const email of [null, undefined, "", "   "]) {
    const db = await ready("legacy");
    await complete(db, "legacy", { email });
    const order = db.store.get("orders/legacy");
    assert.equal(order.statusUpdatedByUid, RIDER, String(email));
    assert.equal("statusUpdatedByEmail" in order, false, `${String(email)}: no stale dispatcher email left behind`);
  }
});

test("completion changes only delivery and attribution fields — never price, VAT, discount, destination, proof or invoice", async () => {
  const ALLOWED = {
    legacy: ["status", "deliveredAt", "statusUpdatedAt", "statusUpdatedByUid", "statusUpdatedByEmail", "updatedAt", "inventoryReconciliation"],
    reserved: ["status", "deliveredAt", "statusUpdatedAt", "statusUpdatedByUid", "statusUpdatedByEmail", "updatedAt", "allocationStatus", "consumedAt", "consumedByUid"],
  };
  for (const orderId of ["legacy", "reserved"]) {
    const db = await ready(orderId);
    const before = structuredClone(db.store.get(`orders/${orderId}`));
    const inventoryBefore = structuredClone(db.store.get("inventory/inv1"));
    await complete(db, orderId);
    const after = db.store.get(`orders/${orderId}`);

    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
      .sort();
    assert.deepEqual(changed, [...ALLOWED[orderId]].sort(), orderId);
    for (const [k, v] of Object.entries(UNTOUCHABLE)) assert.deepEqual(after[k], v, `${orderId}.${k}`);
    for (const k of Object.keys({ ...proofFields(orderId), ...invoiceFields(orderId) })) {
      assert.deepEqual(after[k], before[k], `${orderId}.${k} (evidence untouched)`);
    }
    const inventoryAfter = db.store.get("inventory/inv1");
    if (orderId === "legacy") {
      assert.deepEqual(inventoryAfter, inventoryBefore, "a legacy order moves no stock");
    } else {
      assert.deepEqual(inventoryAfter, { ...inventoryBefore, quantity: 8, reservedQuantity: 0 });
    }
  }
});

test("the callable maps the evidence refusals to failed-precondition and takes the token email", () => {
  const index = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8").replace(/\r\n/g, "\n");
  for (const code of ["proof-missing", "invoice-missing", "evidence-not-yours"]) {
    assert.match(index, new RegExp(`"${code}": "failed-precondition",`), code);
  }
  assert.match(index, /const email = typeof request\.auth\?\.token\?\.email === "string" \? request\.auth\.token\.email : null;/);
  const call = /exports\.markOrderDeliveredWithInventoryConsumption = callable\([\s\S]*?\n\);/.exec(index)[0];
  assert.match(call, /\{ db, FieldValue, uid, email, data, now \}/);
  assert.equal(/data\.email/.test(call), false, "no email taken from the request payload");
  // The evidence check sits AFTER the already-delivered replay, so replays stay idempotent.
  const ops = fs.readFileSync(path.join(__dirname, "..", "src", "operations.js"), "utf8").replace(/\r\n/g, "\n");
  const deliver = ops.slice(ops.indexOf("async function markOrderDeliveredWithInventoryConsumption("));
  assert.ok(deliver.indexOf('if (order.status === "delivered")') < deliver.indexOf("deliveryEvidenceProblem(order, orderId, uid)"));
});

// ------------------------------------------------------------ cancellation attribution

const { cancelOrderWithInventoryRelease } = require("../src/operations");

/** The rider's delay report (Flutter DeliveryService) — leaves the RIDER's email. */
async function reportDelay(db, orderId) {
  const before = db.store.get(`orders/${orderId}`);
  db.update(`orders/${orderId}`, {
    status: "delayed",
    delayReason: "Traffic on the national highway",
    delayedAt: serverTime(),
    statusUpdatedAt: serverTime(),
    statusUpdatedByUid: RIDER,
    statusUpdatedByEmail: RIDER_EMAIL,
    updatedAt: serverTime(),
  });
  return trigger(db, orderId, before, "evt-delay");
}

async function cancel(db, orderId, opts = {}) {
  const uid = opts.uid ?? DISPATCHER;
  const email = "email" in opts ? opts.email : DISPATCHER_EMAIL;
  const before = db.store.get(`orders/${orderId}`);
  const result = await cancelOrderWithInventoryRelease({
    db, FieldValue, uid, email, orderId, reason: "Clinic closed for the holiday",
  });
  const event = await trigger(db, orderId, before, opts.eventId ?? "evt-cancel");
  return { result, event };
}

test("a dispatcher's cancellation is attributed to the dispatcher, not the rider who wrote last", async () => {
  for (const orderId of ["legacy", "reserved"]) {
    const db = fixture();
    await dispatch(db, orderId);
    const delayEvent = await reportDelay(db, orderId);
    assert.equal(db.store.get(`orders/${orderId}`).statusUpdatedByEmail, RIDER_EMAIL, "precondition");

    const { event } = await cancel(db, orderId);
    const order = db.store.get(`orders/${orderId}`);
    assert.equal(order.status, "cancelled", orderId);
    assert.equal(order.statusUpdatedByUid, DISPATCHER, orderId);
    assert.equal(order.statusUpdatedByEmail, DISPATCHER_EMAIL, `${orderId}: not the rider's stale email`);
    assert.ok(isServerTime(order.statusUpdatedAt), orderId);
    // The Cancelled event names the dispatcher; the earlier Delayed event the rider.
    assert.deepEqual(
      { from: event.from, to: event.to, actorUid: event.actorUid },
      { from: "delayed", to: "cancelled", actorUid: DISPATCHER },
      orderId
    );
    assert.deepEqual(db.store.get(`orders/${orderId}/statusEvents/evt-delay`), delayEvent, orderId);
    assert.equal(delayEvent.actorUid, RIDER, orderId);
  }
});

test("a cancelling session without an email clears the stale attribution", async () => {
  for (const email of [null, undefined, ""]) {
    const db = fixture();
    await dispatch(db, "legacy");
    await reportDelay(db, "legacy");
    await cancel(db, "legacy", { email });
    const order = db.store.get("orders/legacy");
    assert.equal(order.statusUpdatedByUid, DISPATCHER, String(email));
    assert.equal("statusUpdatedByEmail" in order, false, `${String(email)}: no stale rider email`);
  }
});

test("a repeated cancellation is a replay: attribution and stock unchanged, no second event", async () => {
  const db = fixture();
  await dispatch(db, "reserved");
  await cancel(db, "reserved", { eventId: "evt-c1" });
  const order = structuredClone(db.store.get("orders/reserved"));
  const stock = structuredClone(db.store.get("inventory/inv1"));
  const { result, event } = await cancel(db, "reserved", { eventId: "evt-c2", uid: DISPATCHER, email: "other@x.com" });
  assert.equal(result.replayed, true);
  assert.equal(event, null);
  assert.deepEqual(db.store.get("orders/reserved"), order, "a replay rewrites nothing, not even the email");
  assert.deepEqual(db.store.get("inventory/inv1"), stock);
});

test("both callables share the attribution helper and take the token email", () => {
  const index = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8").replace(/\r\n/g, "\n");
  const call = /exports\.cancelOrderWithInventoryRelease = callable\([\s\S]*?\n\);/.exec(index)[0];
  assert.match(call, /\{ db, FieldValue, uid, email, data, now \}/);
  assert.match(call, /\n\s+email,\n/);
  assert.equal(/data\.email/.test(call), false, "no email taken from the request payload");
  const ops = fs.readFileSync(path.join(__dirname, "..", "src", "operations.js"), "utf8");
  assert.equal(ops.split("statusUpdatedByEmail: statusUpdatedByEmailValue(email, FieldValue),").length - 1, 2);
});
