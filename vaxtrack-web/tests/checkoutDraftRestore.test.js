/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  attemptStorageKey,
  cartStorageKey,
  initialCheckoutSelection,
  loadCheckoutSelection,
  loadPendingAttempt,
  normalizeCheckoutSelection,
  resolveRestoredDestination,
  saveCartDraft,
  saveCheckoutSelection,
  submitOrderDraft,
} from "../src/services/orderDraftRequest.js";

/**
 * Checkout restoration after a refresh.
 *
 * The bug: only the cart was saved before Finalize. The doctor, destination
 * and requested date lived in React state alone, so a plain refresh lost
 * them. They are now kept on the rep's own cart record (`checkout`) and
 * restored — the destination only once that doctor's options have loaded and
 * it is verifiably one of them.
 *
 * Behaviour is exercised through the real draft helpers the page uses. A
 * refresh is a NEW storage object over the SAME persisted entries — exactly
 * what a reload hands the page. The page wiring itself is pinned at the end.
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
const reload = (storage) => {
  const fresh = new MemoryStorage();
  fresh.map = storage.map;
  return fresh;
};

const UID = "medRepUidAAAAAAAAAAAAAAAAAAAA";
const OTHER = "medRepUidBBBBBBBBBBBBBBBBBBBB";
const CART = { items: [{ inventoryId: "inv1", name: "Hep B", quantity: 2, unitPriceCentavos: 50000 }] };

/** A rep with a cart, as Request Order leaves them on the way to checkout. */
function withCart() {
  const storage = new MemoryStorage();
  assert.equal(saveCartDraft(storage, UID, CART), true);
  return storage;
}
const stored = (storage) => JSON.parse(storage.getItem(cartStorageKey(UID)));

/**
 * The page's own sequence on load: read the saved selection, decide the
 * initial state, then resolve the destination as the doctor's options arrive.
 */
function openCheckout(storage, { plannedDate = "" } = {}) {
  const attempt = loadPendingAttempt(storage, UID)?.submission ?? null;
  const initial = initialCheckoutSelection({
    attempt,
    saved: loadCheckoutSelection(storage, UID),
    plannedDate: attempt ? "" : plannedDate,
  });
  const pending = initial.doctorAddressId
    ? { doctorId: initial.doctorId, destinationId: initial.doctorAddressId }
    : null;
  return { initial, pending };
}

// ------------------------------------------------------------- persistence

test("1. selecting a destination persists its id", () => {
  const storage = withCart();
  saveCheckoutSelection(storage, UID, { doctorId: "docA", doctorAddressId: "home", requestedDeliveryDate: "" });
  assert.equal(stored(storage).checkout.doctorAddressId, "home");
  saveCheckoutSelection(storage, UID, { doctorId: "docA", doctorAddressId: "clinicX", requestedDeliveryDate: "" });
  assert.equal(stored(storage).checkout.doctorAddressId, "clinicX");
  // The cart itself is untouched.
  assert.deepEqual(stored(storage).items, CART.items);
});

test("2. selecting a requested date persists the exact YYYY-MM-DD text", () => {
  const storage = withCart();
  saveCheckoutSelection(storage, UID, { doctorId: "docA", doctorAddressId: "home", requestedDeliveryDate: "2026-10-04" });
  assert.equal(stored(storage).checkout.requestedDeliveryDate, "2026-10-04");
  assert.equal(typeof stored(storage).checkout.requestedDeliveryDate, "string");
});

// ------------------------------------------------------------- restoration

test("3. a refresh restores the saved doctor and date", () => {
  const storage = withCart();
  saveCheckoutSelection(storage, UID, { doctorId: "docA", doctorAddressId: "clinicX", requestedDeliveryDate: "2026-10-04" });
  const { initial } = openCheckout(reload(storage));
  assert.deepEqual(initial, { doctorId: "docA", doctorAddressId: "clinicX", requestedDeliveryDate: "2026-10-04" });
});

test("4. the destination stays pending until that doctor's options load", () => {
  const storage = withCart();
  saveCheckoutSelection(storage, UID, { doctorId: "docA", doctorAddressId: "clinicX", requestedDeliveryDate: "2026-10-04" });
  const { pending } = openCheckout(reload(storage));
  const r = resolveRestoredDestination({ pending, doctorId: "docA", ready: false, optionIds: [] });
  assert.deepEqual(r, { status: "pending", destinationId: "" }, "nothing is shown before verification");
});

test("5. a matching destination is restored once the options arrive", () => {
  const storage = withCart();
  saveCheckoutSelection(storage, UID, { doctorId: "docA", doctorAddressId: "clinicX", requestedDeliveryDate: "2026-10-04" });
  const { pending } = openCheckout(reload(storage));
  const r = resolveRestoredDestination({ pending, doctorId: "docA", ready: true, optionIds: ["home", "clinicX"] });
  assert.deepEqual(r, { status: "restored", destinationId: "clinicX" });
});

test("6. a destination belonging to another doctor is not restored", () => {
  const pending = { doctorId: "docA", destinationId: "clinicX" };
  // The selected doctor differs from the one it was chosen for...
  assert.deepEqual(
    resolveRestoredDestination({ pending, doctorId: "docB", ready: true, optionIds: ["clinicX"] }),
    { status: "rejected", destinationId: "" }
  );
  // ...or no doctor is selected / the saved doctor is no longer active.
  assert.equal(resolveRestoredDestination({ pending, doctorId: "", ready: true, optionIds: ["clinicX"] }).status, "rejected");
  // A destination is never kept without its doctor in the saved draft either.
  assert.deepEqual(
    normalizeCheckoutSelection({ doctorId: "", doctorAddressId: "clinicX", requestedDeliveryDate: "" }),
    { doctorId: "", doctorAddressId: "", requestedDeliveryDate: "" }
  );
});

test("7. a destination that no longer exists is not restored", () => {
  const pending = { doctorId: "docA", destinationId: "clinicGone" };
  assert.deepEqual(
    resolveRestoredDestination({ pending, doctorId: "docA", ready: true, optionIds: ["home", "clinicX"] }),
    { status: "rejected", destinationId: "" }
  );
  assert.equal(resolveRestoredDestination({ pending, doctorId: "docA", ready: true, optionIds: undefined }).status, "rejected");
  assert.equal(resolveRestoredDestination({ pending: null, doctorId: "docA", ready: true, optionIds: [] }).status, "none");
});

test("8. a malformed saved draft never crashes and restores nothing unsafe", () => {
  const key = cartStorageKey(UID);
  const cases = [
    "{not json",
    JSON.stringify({ items: [], ownerUid: UID, checkout: "docA" }),
    JSON.stringify({ items: [], ownerUid: UID, checkout: ["docA"] }),
    JSON.stringify({ items: [], ownerUid: UID, checkout: null }),
    JSON.stringify({ items: [], ownerUid: UID, checkout: { doctorId: 42, doctorAddressId: {}, requestedDeliveryDate: 20261004 } }),
    JSON.stringify({ items: [], ownerUid: UID, checkout: { doctorId: "doctors/docA", doctorAddressId: " home ", requestedDeliveryDate: "2026-02-31" } }),
    JSON.stringify({ items: [], ownerUid: UID, checkout: { doctorId: "docA", doctorAddressId: "home", requestedDeliveryDate: "10/04/2026" } }),
    JSON.stringify({ items: [], ownerUid: OTHER, checkout: { doctorId: "docA", doctorAddressId: "home", requestedDeliveryDate: "2026-10-04" } }),
  ];
  for (const text of cases) {
    const storage = new MemoryStorage();
    storage.setItem(key, text);
    let opened;
    assert.doesNotThrow(() => {
      opened = openCheckout(storage);
    }, text);
    const { initial, pending } = opened;
    assert.equal(typeof initial.doctorId, "string");
    assert.ok(!initial.doctorId.includes("/"), "no path-like doctor id");
    assert.notEqual(initial.requestedDeliveryDate, "2026-02-31", "no impossible date");
    assert.ok(initial.requestedDeliveryDate === "" || /^\d{4}-\d{2}-\d{2}$/.test(initial.requestedDeliveryDate));
    if (pending) assert.equal(pending.doctorId, initial.doctorId);
  }
  // Another rep's record is never read.
  const foreign = new MemoryStorage();
  foreign.setItem(key, cases.at(-1));
  assert.equal(loadCheckoutSelection(foreign, UID), null);
});

test("9. the requested date restores without any timezone shift", () => {
  // Saved and read back as text, in processes whose local zone is far from
  // Manila — including UTC+14, where a naive local/UTC conversion moves days.
  const moduleUrl = new URL("../src/services/orderDraftRequest.js", import.meta.url).href;
  const script = `
    const m = await import(${JSON.stringify(moduleUrl)});
    const map = new Map();
    const s = { getItem: (k) => map.has(k) ? map.get(k) : null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
    const uid = ${JSON.stringify(UID)};
    m.saveCartDraft(s, uid, { items: [] });
    const out = [];
    for (const d of ["2026-10-04", "2026-12-31", "2027-01-01", "2028-02-29"]) {
      m.saveCheckoutSelection(s, uid, { doctorId: "docA", doctorAddressId: "home", requestedDeliveryDate: d });
      out.push(m.initialCheckoutSelection({ saved: m.loadCheckoutSelection(s, uid) }).requestedDeliveryDate);
    }
    out.push(new Date("2026-10-04T00:00:00Z").getTimezoneOffset());
    console.log(JSON.stringify(out));
  `;
  for (const [tz, offset] of [["Pacific/Kiritimati", -840], ["America/Los_Angeles", 420], ["Asia/Manila", -480], ["UTC", 0]]) {
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, TZ: tz },
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout);
    assert.equal(out.pop(), offset, `${tz} really is in effect`);
    assert.deepEqual(out, ["2026-10-04", "2026-12-31", "2027-01-01", "2028-02-29"], tz);
  }
});

// ---------------------------------------------------------- draft lifecycle

test("10. changing doctors clears the destination from the saved draft", () => {
  const storage = withCart();
  saveCheckoutSelection(storage, UID, { doctorId: "docA", doctorAddressId: "clinicX", requestedDeliveryDate: "2026-10-04" });
  // handleDoctorChange: destination "" and no pending restore → the page saves "".
  saveCheckoutSelection(storage, UID, { doctorId: "docB", doctorAddressId: "", requestedDeliveryDate: "2026-10-04" });
  assert.deepEqual(stored(storage).checkout, { doctorId: "docB", doctorAddressId: "", requestedDeliveryDate: "2026-10-04" });
  // Clearing the doctor clears the destination too, whatever the page passes.
  saveCheckoutSelection(storage, UID, { doctorId: "", doctorAddressId: "clinicX", requestedDeliveryDate: "2026-10-04" });
  assert.equal(stored(storage).checkout.doctorAddressId, "");
  // And after a refresh nothing of docA's choice comes back.
  assert.equal(openCheckout(reload(storage)).pending, null);
});

const SUBMISSION = {
  doctorId: "docA",
  doctorAddressId: "clinicX",
  priority: "Standard",
  deliveryInstructions: "",
  requestedDeliveryDate: "2026-10-04",
  items: [{ inventoryId: "inv1", quantity: 2, expectedUnitPriceCentavos: 50000 }],
};

test("11. a failed submission keeps the destination and date for a retry", async () => {
  const storage = withCart();
  saveCheckoutSelection(storage, UID, { doctorId: "docA", doctorAddressId: "clinicX", requestedDeliveryDate: "2026-10-04" });
  await assert.rejects(
    submitOrderDraft({
      storage,
      uid: UID,
      submission: SUBMISSION,
      submit: async () => {
        throw new Error("network down");
      },
    })
  );
  const { initial } = openCheckout(reload(storage));
  assert.equal(initial.doctorAddressId, "clinicX");
  assert.equal(initial.requestedDeliveryDate, "2026-10-04");
});

test("12. a confirmed order clears the editable draft, and it is never recreated", async () => {
  const storage = withCart();
  saveCheckoutSelection(storage, UID, { doctorId: "docA", doctorAddressId: "clinicX", requestedDeliveryDate: "2026-10-04" });
  await submitOrderDraft({ storage, uid: UID, submission: SUBMISSION, submit: async () => ({ orderId: "o1" }) });
  assert.equal(storage.getItem(cartStorageKey(UID)), null);
  assert.equal(loadCheckoutSelection(storage, UID), null);
  // A late save (e.g. a final render before navigation) cannot resurrect it.
  assert.equal(saveCheckoutSelection(storage, UID, { doctorId: "docA", doctorAddressId: "clinicX", requestedDeliveryDate: "2026-10-04" }), false);
  assert.equal(storage.getItem(cartStorageKey(UID)), null);
});

test("13. restoring after a refresh submits nothing and writes no attempt", () => {
  const storage = withCart();
  saveCheckoutSelection(storage, UID, { doctorId: "docA", doctorAddressId: "clinicX", requestedDeliveryDate: "2026-10-04" });
  const fresh = reload(storage);
  const before = new Map(fresh.map);
  const { pending } = openCheckout(fresh);
  resolveRestoredDestination({ pending, doctorId: "docA", ready: true, optionIds: ["clinicX"] });
  assert.equal(fresh.getItem(attemptStorageKey(UID)), null, "no attempt record is created by restoring");
  assert.deepEqual(fresh.map, before, "restoring reads only");
});

test("14. the idempotency key is untouched by draft saves, and a pending attempt wins on restore", async () => {
  const storage = withCart();
  // An attempt whose response was lost: its request id must survive.
  await assert.rejects(
    submitOrderDraft({ storage, uid: UID, submission: SUBMISSION, submit: async () => { throw new Error("lost"); } })
  );
  const attemptBefore = storage.getItem(attemptStorageKey(UID));
  const idBefore = loadPendingAttempt(storage, UID).requestId;

  // Editing and saving the draft never touches the attempt record.
  saveCheckoutSelection(storage, UID, { doctorId: "docB", doctorAddressId: "home", requestedDeliveryDate: "2026-11-01" });
  saveCartDraft(storage, UID, CART);
  assert.equal(storage.getItem(attemptStorageKey(UID)), attemptBefore);

  // After a refresh the SAME id is still pending, and the form reopens on the
  // attempt's snapshot — so an unchanged retry replays instead of duplicating.
  const fresh = reload(storage);
  assert.equal(loadPendingAttempt(fresh, UID).requestId, idBefore);
  const { initial } = openCheckout(fresh);
  assert.deepEqual(initial, { doctorId: "docA", doctorAddressId: "clinicX", requestedDeliveryDate: "2026-10-04" });
});

test("the selection is the rep's own and survives rebuilding the cart", () => {
  const storage = withCart();
  saveCheckoutSelection(storage, UID, { doctorId: "docA", doctorAddressId: "home", requestedDeliveryDate: "2026-10-04" });
  // Another rep on the same browser sees nothing of it.
  assert.equal(loadCheckoutSelection(storage, OTHER), null);
  assert.equal(saveCheckoutSelection(storage, OTHER, { doctorId: "x", doctorAddressId: "", requestedDeliveryDate: "" }), false);
  // "Add more items" rebuilds the cart from the catalog; the selection stays.
  saveCartDraft(storage, UID, { items: [...CART.items, { inventoryId: "inv2", quantity: 1 }] });
  assert.deepEqual(stored(storage).checkout, { doctorId: "docA", doctorAddressId: "home", requestedDeliveryDate: "2026-10-04" });
  // A fresh planner date wins for the date only.
  const { initial } = openCheckout(reload(storage), { plannedDate: "2026-10-09" });
  assert.deepEqual(initial, { doctorId: "docA", doctorAddressId: "home", requestedDeliveryDate: "2026-10-09" });
});

// ------------------------------------------------- the page uses all of this

test("15. the page restores through these helpers, with no lint suppression", () => {
  const page = readFileSync(new URL("../src/pages/salesRep/SalesRepPlaceOrder.jsx", import.meta.url), "utf8");
  // Initial state comes from the saved draft (or a pending attempt).
  assert.match(page, /initialCheckoutSelection\(\{\s*\n\s*attempt: restored,\s*\n\s*saved: uid \? loadCheckoutSelection\(localStorage, uid\) : null,/);
  assert.match(page, /useState\(initialCheckout\.doctorId\)/);
  assert.match(page, /useState\(initialCheckout\.requestedDeliveryDate\)/);
  // The destination is verified against the selected doctor's loaded options.
  assert.match(page, /resolveRestoredDestination\(\{\s*\n\s*pending: pendingRestore,/);
  assert.match(page, /ready: addressesReady && !doctorListLoading,/);
  // doctorListLoading still covers doctors and clinics (plus the territory).
  assert.match(page, /const doctorListLoading =\s*doctorsLoading \|\|\s*clinicsLoading \|\|/);
  assert.match(page, /value=\{destinationId\}/);
  // Every selection change is saved to the draft — and only to the draft.
  // The saved doctor is the one still permitted (kept as-is while loading),
  // so a doctor outside the territory is not written back into the draft.
  assert.match(page, /saveCheckoutSelection\(localStorage, uid, \{\s*\n\s*doctorId: doctorSelectValue,\s*\n\s*doctorAddressId: draftDestinationId,\s*\n\s*requestedDeliveryDate: requestedDate,/);
  // A user's doctor change clears the destination and any pending restore.
  const doctorChange = /const handleDoctorChange = \(doctorId\) => \{([\s\S]*?)\n {2}\};/.exec(page)[1];
  assert.match(doctorChange, /setSelectedDestinationId\(""\);/);
  assert.match(doctorChange, /setPendingRestore\(null\);/);
  // Orders are only ever submitted from the Finalize handler.
  assert.equal((page.match(/submitOrderDraft\(/g) ?? []).length, 1);
  assert.match(page, /const handleFinalizeOrder = async \(\) => \{[\s\S]*?await submitOrderDraft\(/);
  assert.doesNotMatch(page, /eslint-disable/);
});
