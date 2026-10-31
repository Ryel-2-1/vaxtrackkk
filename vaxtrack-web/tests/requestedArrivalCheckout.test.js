import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  canonicalSubmission,
  cartStorageKey,
  diffSubmission,
  initialCheckoutSelection,
  loadCheckoutSelection,
  loadPendingAttempt,
  saveCartDraft,
  saveCheckoutSelection,
  submitOrderDraft,
} from "../src/services/orderDraftRequest.js";
import { buildConfirmationFromOrder } from "../src/services/orderConfirmation.js";

/**
 * The requested arrival through the Med Rep checkout: kept in the draft while
 * the rep moves around, restored after a refresh, part of the retry snapshot
 * (a changed preference never replays an earlier order), and shown from the
 * stored order on confirmation. Page and server wiring is pinned at the end.
 */

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    this.map.set(key, String(value));
  }
  removeItem(key) {
    this.map.delete(key);
  }
}

const UID = "medRepUidAAAAAAAAAAAAAAAAAAAA";
const CART = { items: [{ inventoryId: "inv1", name: "Hep B", quantity: 2, unitPriceCentavos: 50000 }] };
const withCart = () => {
  const storage = new MemoryStorage();
  assert.equal(saveCartDraft(storage, UID, CART), true);
  return storage;
};
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const submission = (requestedArrival) => ({
  doctorId: "docA",
  doctorAddressId: "home",
  priority: "Standard",
  deliveryInstructions: "",
  requestedDeliveryDate: "2026-10-28",
  ...(requestedArrival === undefined ? {} : { requestedArrival }),
  items: [{ inventoryId: "inv1", quantity: 2, expectedUnitPriceCentavos: 50000 }],
});

test("the default checkout is genuinely flexible: no time is prefilled", () => {
  const initial = initialCheckoutSelection({ saved: null });
  assert.deepEqual(initial.requestedArrival, { mode: "any_time", start: "", end: "", time: "" });
});

test("a chosen preference survives navigation and a refresh with the draft", () => {
  const storage = withCart();
  saveCheckoutSelection(storage, UID, {
    doctorId: "docA",
    doctorAddressId: "home",
    requestedDeliveryDate: "2026-10-28",
    requestedArrival: { mode: "window", start: "10:00", end: "12:00", time: "" },
  });
  const initial = initialCheckoutSelection({ saved: loadCheckoutSelection(storage, UID) });
  assert.deepEqual(initial.requestedArrival, { mode: "window", start: "10:00", end: "12:00", time: "" });
  // A half-entered window is kept as entered, so the rep can finish it.
  saveCheckoutSelection(storage, UID, { doctorId: "docA", requestedArrival: { mode: "window", start: "10:00", end: "" } });
  assert.deepEqual(loadCheckoutSelection(storage, UID).requestedArrival, { mode: "window", start: "10:00", end: "", time: "" });
  // Clearing the preference saves the flexible day again.
  saveCheckoutSelection(storage, UID, { doctorId: "docA", requestedArrival: { mode: "any_time" } });
  assert.equal(JSON.parse(storage.getItem(cartStorageKey(UID))).checkout.requestedArrival.mode, "any_time");
});

test("a draft saved before requested times existed reads as any time", () => {
  const storage = withCart();
  saveCheckoutSelection(storage, UID, { doctorId: "docA", doctorAddressId: "home", requestedDeliveryDate: "2026-10-28" });
  const raw = JSON.parse(storage.getItem(cartStorageKey(UID)));
  delete raw.checkout.requestedArrival;
  storage.setItem(cartStorageKey(UID), JSON.stringify(raw));
  assert.equal(loadCheckoutSelection(storage, UID).requestedArrival.mode, "any_time");
});

test("the Delivery Planner hands over a date only; the time preference is untouched", () => {
  const saved = { doctorId: "docA", doctorAddressId: "home", requestedDeliveryDate: "2026-10-28", requestedArrival: { mode: "before", time: "10:00" } };
  const initial = initialCheckoutSelection({ saved, plannedDate: "2026-11-02" });
  assert.equal(initial.requestedDeliveryDate, "2026-11-02");
  assert.deepEqual(initial.requestedArrival, { mode: "before", start: "", end: "", time: "10:00" });
});

test("the retry snapshot carries the arrival; absent and any_time are the same request", () => {
  assert.deepEqual(canonicalSubmission(submission(undefined)).requestedArrival, { mode: "any_time" });
  assert.deepEqual(canonicalSubmission(submission({ version: 1, mode: "exact", time: "10:00" })).requestedArrival, { mode: "exact", time: "10:00" });
  assert.deepEqual(diffSubmission(submission(undefined), submission({ mode: "any_time" })), []);
  assert.deepEqual(diffSubmission(submission({ mode: "exact", time: "10:00" }), submission({ mode: "before", time: "10:00" })), ["requested time"]);
  assert.deepEqual(diffSubmission(submission({ mode: "exact", time: "10:00" }), submission({ mode: "exact", time: "10:30" })), ["requested time"]);
});

test("a changed preference is refused against a pending attempt instead of replaying it", async () => {
  const storage = withCart();
  let sent = 0;
  const failing = async () => {
    sent += 1;
    throw Object.assign(new Error("timeout"), { code: "deadline-exceeded" });
  };
  await assert.rejects(
    submitOrderDraft({ storage, uid: UID, submission: submission({ mode: "exact", time: "10:00" }), submit: failing, generate: () => "reqIdAAAAAAAAAAAAAAAA1" })
  );
  assert.equal(loadPendingAttempt(storage, UID).submission.requestedArrival.time, "10:00");
  await assert.rejects(
    submitOrderDraft({ storage, uid: UID, submission: submission({ mode: "exact", time: "11:00" }), submit: failing }),
    (e) => e.code === "draft-changed" && e.details.changedFields.includes("requested time")
  );
  assert.equal(sent, 1, "the changed request was never sent");
  // The unchanged retry goes out under the same request id.
  let usedId = null;
  await submitOrderDraft({
    storage,
    uid: UID,
    submission: submission({ mode: "exact", time: "10:00" }),
    submit: async (id) => {
      usedId = id;
      return { orderId: "o1" };
    },
  });
  assert.equal(usedId, "reqIdAAAAAAAAAAAAAAAA1");
});

test("a pending attempt restores its own requested arrival, not the saved draft's", () => {
  const attempt = canonicalSubmission(submission({ mode: "window", start: "09:00", end: "11:00" }));
  const initial = initialCheckoutSelection({ attempt, saved: { requestedArrival: { mode: "exact", time: "15:00" } } });
  assert.deepEqual(initial.requestedArrival, { mode: "window", start: "09:00", end: "11:00", time: "" });
});

test("the confirmation is built from the stored order's requested arrival", () => {
  const c = buildConfirmationFromOrder({ id: "o1", requestedDeliveryDate: "2026-10-28", requestedArrival: { version: 1, mode: "before", time: "10:00" } });
  assert.deepEqual(c.requestedArrival, { version: 1, mode: "before", time: "10:00" });
  assert.equal(buildConfirmationFromOrder({ id: "o2" }).requestedArrival, null, "an older order has none (any time)");
});

// ------------------------------------------------------------------ wiring

test("checkout: optional field, validated before review, sent with the order", () => {
  const page = read("src/pages/salesRep/SalesRepPlaceOrder.jsx");
  assert.match(page, /<RequestedArrivalField\s+value=\{arrival\}\s+onChange=\{handleArrivalChange\}/);
  assert.match(page, /const recovering = Boolean\(uid && loadPendingAttempt\(localStorage, uid\)\);/);
  assert.match(page, /const \{ date: requestedCheck, arrival: arrivalCheck \} = validateCheckoutSchedule\(\{/);
  assert.match(page, /requestedArrival: arrivalPayloadOf\(arrival\),\s*recovering,/);
  assert.match(page, /requestedArrival: arrivalCheck\.value,/, "in the retry snapshot");
  assert.match(page, /requestedArrival: submission\.requestedArrival,/, "and in the callable payload");
  assert.match(page, /schedule=\{arrivalShape\.ok \? requestedScheduleLabel\(requestedDate, arrivalShape\.value\) : ""\}/, "shown in the final review");
  // The reconfirmation dialog is opened only after the arrival check passes.
  assert.ok(page.indexOf("arrival: arrivalCheck") < page.indexOf("setConfirmOpen(true)"));
  const field = read("src/components/schedule/RequestedArrivalField.jsx");
  assert.match(field, /Requested delivery time <span className="arrival-optional">\(optional\)<\/span>/);
  assert.match(field, /not\s+when the rider leaves the hub/);
  assert.match(field, /Clear time preference/);
  assert.match(field, /type="time"/);
  assert.equal(/defaultValue|"09:00"|"08:00"/.test(field), false, "no hour is prefilled");
});

test("server: validated at the creation boundary, stored, on the receipt, and client-unwritable", () => {
  const ops = read("functions/src/operations.js");
  assert.match(ops, /const requestedArrival = normalizeRequestedArrival\(payload\?\.requestedArrival, \{/);
  assert.ok(ops.indexOf("normalizeRequestedArrival(payload") < ops.indexOf("canonicalRequestFingerprint({"));
  assert.match(ops, /schedule: \{ requestedDeliveryDate, requestedArrival \},/);
  assert.match(ops, /const expected = version === 3 \? fingerprint : version === 2 \? arrivalFingerprint : version === 1 \? legacyFingerprint : null;/);
  assert.match(ops, /fingerprintVersion: 3,/);
  assert.ok(ops.indexOf("if (keySnap.exists)") < ops.indexOf("normalizeRequestedDeliveryDate(requestedDeliveryDate, now)"), "replay before temporal rejection");
  assert.match(ops, /original\.requestedDeliveryDate !== requestedDeliveryDate/);
  assert.match(ops, /items: allocationLines,\s*\/\/[\s\S]*?requestedArrival,/);
  const history = read("functions/src/orderHistory.js");
  assert.match(history, /requestedArrival: orderFields\.requestedArrival \?\? null,/);
  const rules = read("firestore.rules");
  const serverOnly = rules.slice(rules.indexOf("function serverOnlyOrderFields()"), rules.indexOf("];", rules.indexOf("function serverOnlyOrderFields()")));
  assert.match(serverOnly, /'requestedArrival'/);
});

test("Med Rep and Dispatcher screens show the requested arrival", () => {
  for (const [file, pattern] of [
    ["src/pages/salesRep/SalesRepOrderConfirmation.jsx", /Arrival at the destination: \{requestedArrivalLabel\(order\.requestedArrival\)\}/],
    ["src/pages/salesRep/SalesRepOrderTracking.jsx", /Requested arrival: \{requestedArrivalLabel\(selectedOrder\.requestedArrival\)\}/],
    ["src/components/history/OrderHistoryDetail.jsx", /<Field label="Requested arrival">\{requestedArrivalLabel\(requestedArrivalOf\(receipt\)\)\}<\/Field>/],
    ["src/pages/dispatcher/DispatcherDashboard.jsx", /dispatcher-dash-arrival">\{requestedArrivalLabel\(requestedArrivalOf\(order\)\)\}/],
    ["src/pages/dispatcher/DispatcherAssignRider.jsx", /<span>Requested arrival<\/span>/],
    ["src/pages/dispatcher/DispatcherCargoLoading.jsx", /Requested arrival: \{requestedScheduleLabel\(order\.requestedDeliveryDate, requestedArrivalOf\(order\)\)\}/],
    ["src/components/dispatch/TripProgress.jsx", /Requested: \{requestedArrivalLabel\(requestedArrivalOf\(stop\.order\)\)\}/],
    // The calendar card, shared by Admin/Dispatcher's calendar and the Med Rep planner.
    ["src/components/schedule/DeliveryEventCard.jsx", /<Field label="Requested arrival" value=\{requestedArrivalLabel\(requestedArrivalOf\(order\)\)\} \/>/],
  ]) {
    assert.match(read(file), pattern, file);
  }
  // Requested, estimated and actual departure are labelled apart on Live Tracking.
  const geo = read("src/pages/dispatcher/DispatcherGeofence.jsx");
  assert.match(geo, /Estimated arrival at dispatch:/);
  assert.match(geo, /Left the hub:/);
  assert.match(geo, /<TripProgress progress=\{progress\}/);
  assert.match(read("src/components/dispatch/TripProgress.jsx"), /Planned arrival \{stop\.order\.stopEtaText/);
});

test("the createOrderWithReservation wrapper forwards the requested arrival to the callable", () => {
  // Regression guard (found in the browser check): the page sent
  // requestedArrival, but the wrapper copies fields one by one and dropped it,
  // so a timed request was stored as "any time" — the same failure the
  // requested date once had.
  const src = read("src/services/inventoryCallables.js");
  const fn = /export async function createOrderWithReservation\(\{[\s\S]*?\n\s+return result\.data;/.exec(src);
  assert.ok(fn, "the wrapper must exist");
  const body = fn[0];
  assert.match(body.slice(0, body.indexOf("}) {")), /\n\s+requestedArrival,\r?\n/, "the wrapper must accept the field");
  const createAt = body.indexOf("callables().create({");
  const itemsAt = body.indexOf("items:", createAt);
  const fieldAt = body.indexOf("...(requestedArrival ? { requestedArrival } : {}),", createAt);
  assert.ok(createAt !== -1 && fieldAt !== -1 && fieldAt < itemsAt, "and forward it in the create() payload");
});
