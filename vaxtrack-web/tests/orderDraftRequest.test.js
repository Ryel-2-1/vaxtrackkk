import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LEGACY_CART_KEY,
  REQUEST_ID_PATTERN,
  STORAGE_UNAVAILABLE_MESSAGE,
  OrderDraftError,
  newRequestId,
  isValidRequestId,
  cartStorageKey,
  attemptStorageKey,
  loadCartDraft,
  saveCartDraft,
  updateCartDraftLines,
  canonicalSubmission,
  diffSubmission,
  loadPendingAttempt,
  discardOrderAttempt,
  discardOrderDraft,
  submitOrderDraft,
} from "../src/services/orderDraftRequest.js";

/**
 * The Med Rep order draft: user-scoped carts, and a request id that survives a
 * refresh — persisted and verified before the server is ever called — plus a
 * snapshot that stops a changed retry being silently replayed as the original.
 *
 * A "refresh" is a new storage object over the same persisted entries, which is
 * exactly what a reload gives the page.
 */

class MemoryStorage {
  constructor(entries) {
    this.map = new Map(entries);
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
/** Private browsing / quota exceeded: writes throw. */
class FailingWriteStorage extends MemoryStorage {
  setItem() {
    throw new Error("QuotaExceededError");
  }
}
/** A write that reports success but does not stick (read-back mismatch). */
class NonDurableStorage extends MemoryStorage {
  setItem() {
    // silently dropped
  }
}

const UID_A = "medRepUidAAAAAAAAAAAAAAAAAAAA";
const UID_B = "medRepUidBBBBBBBBBBBBBBBBBBBB";
/** A page refresh: a fresh storage object over the SAME persisted entries. */
const reload = (storage) => {
  const fresh = new MemoryStorage();
  fresh.map = storage.map;
  return fresh;
};

const submission = (over = {}) => ({
  doctorId: "doc1",
  doctorAddressId: "home",
  priority: "Standard",
  deliveryInstructions: "Leave at reception",
  requestedDeliveryDate: "2026-10-20",
  items: [
    { inventoryId: "inv1", quantity: 2, expectedUnitPriceCentavos: 50000 },
    { inventoryId: "inv2", quantity: 1, expectedUnitPriceCentavos: 12000 },
  ],
  ...over,
});
const cart = (items = [{ inventoryId: "inv1", name: "A", quantity: 2, unitPriceCentavos: 50000 }]) => ({
  totalVials: 2,
  storageSlots: items.length,
  items,
  createdAt: "2026-10-01T00:00:00.000Z",
});

/** A submit that records the id it was given, and fails with [error] if set. */
function recorder(error) {
  const sent = [];
  const submit = async (requestId) => {
    sent.push(requestId);
    if (error) throw error;
    return { orderId: "order1", orderNumber: "VT-ORD-1", replayed: false };
  };
  return { sent, submit };
}

// ================================================= 1–5. user-scoped carts

test("1. User A's cart cannot be loaded by User B", () => {
  const storage = new MemoryStorage();
  assert.equal(saveCartDraft(storage, UID_A, cart()), true);
  assert.equal(loadCartDraft(storage, UID_B).draft, null);
  assert.notEqual(cartStorageKey(UID_A), cartStorageKey(UID_B));
});

test("2. User A's cart is still there when User A returns", () => {
  const storage = new MemoryStorage();
  saveCartDraft(storage, UID_A, cart());
  loadCartDraft(storage, UID_B); // another user signs in on this browser
  const back = loadCartDraft(reload(storage), UID_A);
  assert.equal(back.draft.items[0].inventoryId, "inv1");
  assert.equal(back.draft.ownerUid, UID_A);
});

test("3. a legacy unscoped cart is migrated exactly once", () => {
  const legacy = JSON.stringify(cart());
  const storage = new MemoryStorage([[LEGACY_CART_KEY, legacy]]);
  const first = loadCartDraft(storage, UID_A);
  assert.equal(first.migrated, true);
  assert.equal(first.draft.ownerUid, UID_A);
  assert.equal(storage.getItem(LEGACY_CART_KEY), null, "unscoped record removed after migration");
  const again = loadCartDraft(storage, UID_A);
  assert.equal(again.migrated, false, "not migrated a second time");
  assert.equal(again.draft.items[0].inventoryId, "inv1");
});

test("4. User B cannot migrate a legacy cart User A already claimed", () => {
  const storage = new MemoryStorage([[LEGACY_CART_KEY, JSON.stringify(cart())]]);
  loadCartDraft(storage, UID_A); // A claims it
  const b = loadCartDraft(storage, UID_B);
  assert.equal(b.draft, null);
  assert.equal(b.migrated, false);
});

test("a user with their own cart never claims (or deletes) the legacy one", () => {
  const legacy = JSON.stringify(cart([{ inventoryId: "legacyInv", quantity: 9 }]));
  const storage = new MemoryStorage([[LEGACY_CART_KEY, legacy]]);
  saveCartDraft(storage, UID_A, cart());
  const a = loadCartDraft(storage, UID_A);
  assert.equal(a.migrated, false);
  assert.equal(a.draft.items[0].inventoryId, "inv1");
  assert.equal(storage.getItem(LEGACY_CART_KEY), legacy, "left untouched for its owner");
});

test("a migration that cannot be verified loads nothing and removes nothing", () => {
  const legacy = JSON.stringify(cart());
  const storage = new FailingWriteStorage([[LEGACY_CART_KEY, legacy]]);
  assert.equal(loadCartDraft(storage, UID_A).draft, null);
  assert.equal(storage.getItem(LEGACY_CART_KEY), legacy);
});

test("a cart under one user's key that names another owner is refused", () => {
  const forged = JSON.stringify({ ...cart(), ownerUid: UID_A });
  const storage = new MemoryStorage([[cartStorageKey(UID_B), forged]]);
  assert.equal(loadCartDraft(storage, UID_B).draft, null);
});

test("5. with no signed-in user a cart cannot be loaded, saved or submitted", async () => {
  for (const uid of [undefined, null, "", "   ", " padded "]) {
    const storage = new MemoryStorage([[LEGACY_CART_KEY, JSON.stringify(cart())]]);
    assert.throws(() => loadCartDraft(storage, uid), (e) => e.code === "unauthenticated");
    assert.throws(() => saveCartDraft(storage, uid, cart()), (e) => e.code === "unauthenticated");
    const { sent, submit } = recorder();
    await assert.rejects(
      submitOrderDraft({ storage, uid, submission: submission(), submit }),
      (e) => e instanceof OrderDraftError && e.code === "unauthenticated"
    );
    assert.equal(sent.length, 0, "the callable never ran");
    assert.notEqual(storage.getItem(LEGACY_CART_KEY), null, "and nothing was migrated");
  }
});

// ================================================ 6–8. durable persistence

test("6. a failed storage write blocks the callable", async () => {
  const storage = new FailingWriteStorage();
  const { sent, submit } = recorder();
  await assert.rejects(
    submitOrderDraft({ storage, uid: UID_A, submission: submission(), submit }),
    (e) => e.code === "storage-unavailable" && e.message === STORAGE_UNAVAILABLE_MESSAGE
  );
  assert.equal(sent.length, 0);
});

test("7. a failed read-back verification blocks the callable", async () => {
  const storage = new NonDurableStorage();
  const { sent, submit } = recorder();
  await assert.rejects(
    submitOrderDraft({ storage, uid: UID_A, submission: submission(), submit }),
    (e) => e.code === "storage-unavailable"
  );
  assert.equal(sent.length, 0);
});

test("8. no memory-only id is ever submitted", async () => {
  // Every id the callable receives is already in durable storage, with the
  // exact snapshot being submitted.
  const storage = new MemoryStorage();
  let durable = null;
  await submitOrderDraft({
    storage,
    uid: UID_A,
    submission: submission(),
    submit: async (requestId) => {
      durable = loadPendingAttempt(reload(storage), UID_A);
      assert.equal(durable.requestId, requestId);
      return { orderId: "o" };
    },
  });
  assert.deepEqual(durable.submission, canonicalSubmission(submission()));
  // And when storage fails, there is no fallback id at all (tests 6–7).
});

test("generated ids are server-shaped and match the server's own validation", async () => {
  const { validateRequestId } = await import("../functions/src/policy.js");
  const serverAccepts = (v) => {
    try {
      validateRequestId(v);
      return true;
    } catch {
      return false;
    }
  };
  for (const sample of [newRequestId(), "a".repeat(16), "a".repeat(64), "a".repeat(15),
    "a".repeat(65), "", "   ", "has space in it!", "slash/not/allowed1", null, 1234567890123456]) {
    assert.equal(isValidRequestId(sample), serverAccepts(sample), JSON.stringify(sample));
  }
  for (let i = 0; i < 50; i++) assert.match(newRequestId(), REQUEST_ID_PATTERN);
});

// ============================================ 9–13. changed-draft detection

async function attemptOnce(storage, sub) {
  const { sent, submit } = recorder(new Error("network"));
  await assert.rejects(submitOrderDraft({ storage, uid: UID_A, submission: sub, submit }));
  return sent[0];
}

test("9. an unchanged retry — even after a refresh — reuses the same id", async () => {
  const storage = new MemoryStorage();
  const firstId = await attemptOnce(storage, submission());
  // Lines in a different order are still the same submission.
  const reordered = submission({ items: [...submission().items].reverse() });
  const { sent, submit } = recorder();
  await submitOrderDraft({ storage: reload(storage), uid: UID_A, submission: reordered, submit });
  assert.deepEqual(sent, [firstId]);
});

for (const [n, label, change] of [
  ["10", "priority", { priority: "Urgent" }],
  ["11", "instructions", { deliveryInstructions: "Call the doctor first" }],
  ["12", "requested date", { requestedDeliveryDate: "2026-10-21" }],
  ["13a", "quantity", { items: [{ inventoryId: "inv1", quantity: 3, expectedUnitPriceCentavos: 50000 }, { inventoryId: "inv2", quantity: 1, expectedUnitPriceCentavos: 12000 }] }],
  ["13b", "destination", { doctorAddressId: "clinicX" }],
  ["13c", "doctor", { doctorId: "doc2" }],
  ["13d", "price", { items: [{ inventoryId: "inv1", quantity: 2, expectedUnitPriceCentavos: 55000 }, { inventoryId: "inv2", quantity: 1, expectedUnitPriceCentavos: 12000 }] }],
  ["13e", "items", { items: [{ inventoryId: "inv1", quantity: 2, expectedUnitPriceCentavos: 50000 }] }],
]) {
  test(`${n}. a changed ${label} blocks a silent replay`, async () => {
    const storage = new MemoryStorage();
    const firstId = await attemptOnce(storage, submission());
    const { sent, submit } = recorder();
    await assert.rejects(
      submitOrderDraft({ storage, uid: UID_A, submission: submission(change), submit }),
      (e) => e.code === "draft-changed" && e.details.changedFields.includes(label) &&
        /Check Order Tracking/.test(e.message)
    );
    assert.equal(sent.length, 0, "the server is not called with the same id");
    assert.equal(loadPendingAttempt(storage, UID_A).requestId, firstId, "the original id is kept");
  });
}

test("blank and missing requested dates are the same; whitespace in instructions is ignored", () => {
  assert.deepEqual(
    diffSubmission(submission({ requestedDeliveryDate: null, deliveryInstructions: "x" }),
      submission({ requestedDeliveryDate: "", deliveryInstructions: "  x  " })),
    []
  );
});

// ======================================== 16–18. discard and no rotation

test("16. not discarding (cancelling the warning) leaves the attempt untouched", async () => {
  const storage = new MemoryStorage([[cartStorageKey(UID_A), JSON.stringify({ ...cart(), ownerUid: UID_A })]]);
  const firstId = await attemptOnce(storage, submission());
  const before = storage.getItem(attemptStorageKey(UID_A));
  // Cancel performs no storage operation at all; the page wiring is pinned below.
  assert.equal(storage.getItem(attemptStorageKey(UID_A)), before);
  assert.equal(loadPendingAttempt(storage, UID_A).requestId, firstId);
});

test("17. confirming the discard clears the attempt but keeps the cart", async () => {
  const savedCart = JSON.stringify({ ...cart(), ownerUid: UID_A });
  const storage = new MemoryStorage([[cartStorageKey(UID_A), savedCart]]);
  const firstId = await attemptOnce(storage, submission());
  discardOrderAttempt(storage, UID_A);
  assert.equal(loadPendingAttempt(storage, UID_A), null);
  assert.equal(storage.getItem(cartStorageKey(UID_A)), savedCart, "cart kept");
  // The next Finalize — even with changed details — is a new attempt, new id.
  const { sent, submit } = recorder();
  await submitOrderDraft({ storage, uid: UID_A, submission: submission({ priority: "Urgent" }), submit });
  assert.notEqual(sent[0], firstId);
});

test("18. no failure ever rotates the id on its own", async () => {
  for (const error of [
    new Error("Failed to fetch"),
    Object.assign(new Error("timeout"), { code: "deadline-exceeded" }),
    Object.assign(new Error("unknown"), { code: "service-unavailable" }),
    Object.assign(new Error("different contents"), { code: "idempotency-conflict" }),
    new Error("The order may have been saved, but the server's reply was incomplete."),
  ]) {
    const storage = new MemoryStorage();
    const sent = [];
    for (let i = 0; i < 3; i++) {
      // Each retry reads the attempt back fresh, as a refresh would.
      await assert.rejects(submitOrderDraft({
        storage: reload(storage),
        uid: UID_A,
        submission: submission(),
        submit: async (id) => { sent.push(id); throw error; },
      }));
    }
    assert.equal(new Set(sent).size, 1, error.code ?? error.message);
  }
});

test("a valid id whose snapshot is unreadable keeps the id and re-records the snapshot", async () => {
  const id = newRequestId();
  const storage = new MemoryStorage([[attemptStorageKey(UID_A), JSON.stringify({ v: 1, uid: UID_A, requestId: id })]]);
  const { sent, submit } = recorder(new Error("network"));
  await assert.rejects(submitOrderDraft({ storage, uid: UID_A, submission: submission(), submit }));
  assert.deepEqual(sent, [id], "the id that may have reached the server is reused");
  assert.deepEqual(loadPendingAttempt(storage, UID_A).submission, canonicalSubmission(submission()));
});

test("an invalid stored id is replaced — the server never accepted one", async () => {
  const storage = new MemoryStorage([[attemptStorageKey(UID_A), JSON.stringify({ v: 1, uid: UID_A, requestId: "bad id!", submission: submission() })]]);
  const { sent, submit } = recorder(new Error("network"));
  await assert.rejects(submitOrderDraft({ storage, uid: UID_A, submission: submission(), submit }));
  assert.ok(isValidRequestId(sent[0]));
});

test("another user's attempt is never inherited", async () => {
  const storage = new MemoryStorage();
  const aId = await attemptOnce(storage, submission());
  const { sent, submit } = recorder(new Error("network"));
  await assert.rejects(submitOrderDraft({ storage, uid: UID_B, submission: submission(), submit }));
  assert.notEqual(sent[0], aId);
  assert.equal(loadPendingAttempt(storage, UID_A).requestId, aId, "A's attempt intact");
});

// ============================================================ 20. success

test("20. confirmed success clears the user's cart, request id and snapshot", async () => {
  const storage = new MemoryStorage([
    [cartStorageKey(UID_A), JSON.stringify({ ...cart(), ownerUid: UID_A })],
    [cartStorageKey(UID_B), JSON.stringify({ ...cart(), ownerUid: UID_B })],
  ]);
  const { sent, submit } = recorder();
  const result = await submitOrderDraft({ storage, uid: UID_A, submission: submission(), submit });
  assert.equal(result.orderId, "order1");
  assert.equal(storage.getItem(cartStorageKey(UID_A)), null);
  assert.equal(storage.getItem(attemptStorageKey(UID_A)), null);
  assert.notEqual(storage.getItem(cartStorageKey(UID_B)), null, "another user's draft is untouched");
  // The next order gets a new id.
  const next = recorder();
  await submitOrderDraft({ storage, uid: UID_A, submission: submission(), submit: next.submit });
  assert.notEqual(next.sent[0], sent[0]);
});

test("discardOrderDraft clears the whole draft (attempt and cart)", async () => {
  const storage = new MemoryStorage([[cartStorageKey(UID_A), JSON.stringify({ ...cart(), ownerUid: UID_A })]]);
  await attemptOnce(storage, submission());
  discardOrderDraft(storage, UID_A);
  assert.equal(storage.map.size, 0);
});

// ====================================================== cart write-through

test("checkout edits are mirrored into the user's own cart only", () => {
  const storage = new MemoryStorage();
  saveCartDraft(storage, UID_A, cart([
    { inventoryId: "inv1", name: "A", quantity: 2, unitPriceCentavos: 100 },
    { inventoryId: "inv2", name: "B", quantity: 5, unitPriceCentavos: 200 },
  ]));
  assert.equal(updateCartDraftLines(storage, UID_A, [{ inventoryId: "inv1", quantity: 7 }]), true);
  const saved = loadCartDraft(storage, UID_A).draft;
  assert.deepEqual(saved.items, [{ inventoryId: "inv1", name: "A", quantity: 7, unitPriceCentavos: 100 }]);
  assert.equal(saved.totalVials, 7);
  assert.equal(updateCartDraftLines(storage, UID_B, [{ inventoryId: "inv1", quantity: 1 }]), false);
});

test("write-through never recreates a cart cleared by a confirmed order", () => {
  const storage = new MemoryStorage();
  assert.equal(updateCartDraftLines(storage, UID_A, [{ inventoryId: "inv1", quantity: 1 }]), false);
  assert.equal(storage.map.size, 0);
});

// ============================================================ page wiring
// The pages import Firebase and cannot be rendered in this runner. These pin,
// narrowly, that they route through the helper above.

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const PLACE = read("src/pages/salesRep/SalesRepPlaceOrder.jsx");
const REQUEST = read("src/pages/salesRep/SalesRepRequestOrder.jsx");

test("Request Order saves the cart only under the signed-in user", () => {
  assert.match(REQUEST, /if \(!saveCartDraft\(localStorage, uid, orderDraft\)\) \{/);
  assert.equal(/localStorage\.setItem\(/.test(REQUEST), false, "no unscoped cart write remains");
});

test("Place Order submits the full snapshot through the durable draft", () => {
  assert.match(PLACE, /await submitOrderDraft\(\{\s*storage: localStorage,\s*uid,\s*submission,\s*submit:/);
  assert.match(PLACE, /loadCartDraft\(localStorage, uid\)/);
  for (const field of ["priority", "deliveryInstructions", "requestedDeliveryDate", "doctorId", "doctorAddressId", "items"]) {
    assert.match(PLACE, new RegExp(`const submission = \\{[\\s\\S]*?${field}:`), field);
  }
  assert.equal(/newRequestId\(|requestIdRef/.test(PLACE), false, "no page-memory id");
});

test("16 + 17. the discard is two-step: cancel only closes; confirm clears the attempt only", () => {
  const cancel = /const handleCancelDiscard = \(\) => \{([\s\S]*?)\n {2}\};/.exec(PLACE);
  assert.ok(cancel, "cancel handler exists");
  assert.equal(/discardOrder/.test(cancel[1]), false, "cancel clears nothing");
  const confirm = /const handleConfirmDiscard = \(\) => \{([\s\S]*?)\n {2}\};/.exec(PLACE);
  assert.match(confirm[1], /discardOrderAttempt\(localStorage, uid\);/);
  assert.equal(/discardOrderDraft/.test(PLACE), false, "the cart is never discarded from checkout");
  assert.equal((PLACE.match(/discardOrderAttempt\(/g) ?? []).length, 1, "one call site");
  assert.match(PLACE, /onClick=\{handleRequestDiscard\}/);
  assert.match(PLACE, /onClick=\{handleCancelDiscard\}/);
  assert.match(PLACE, /onClick=\{handleConfirmDiscard\}/);
  assert.match(PLACE, /may already have created an order/);
});
