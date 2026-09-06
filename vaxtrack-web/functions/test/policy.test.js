"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../src/policy");

const NOW = new Date("2026-09-06T02:00:00.000Z"); // 10:00 in Manila

const batch = (over = {}) => ({
  quantity: 100,
  reservedQuantity: 10,
  status: "OK",
  expiryDate: "2027-12-31",
  batchId: "MOD-STG-001",
  vaccineName: "Moderna COVID-19 Vaccine",
  vaccineType: "COVID-19",
  manufacturer: "Moderna",
  ...over,
});

const evaluate = (over = {}, requested = 5) =>
  P.evaluateBatch({ inventoryId: "inv1", data: batch(over), requested, now: NOW });

const codeOf = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e.code;
  }
};

test("expiry uses a date-only Manila cutoff", async (t) => {
  await t.test("a batch is usable through the whole of its expiry date", () => {
    // 2026-09-06T02:00Z is already 2026-09-06 in Manila (UTC+8).
    assert.equal(P.manilaDateString(NOW), "2026-09-06");
    assert.equal(P.isExpired("2026-09-06", NOW), false);
    assert.equal(P.isExpired("2026-09-05", NOW), true);
    assert.equal(P.isExpired("2026-09-07", NOW), false);
  });

  await t.test("late-evening UTC is already tomorrow in Manila", () => {
    // 2026-09-05T17:00Z == 2026-09-06 01:00 in Manila. A UTC-based cutoff
    // would still call it the 5th and keep an expired batch orderable.
    const evening = new Date("2026-09-05T17:00:00.000Z");
    assert.equal(P.manilaDateString(evening), "2026-09-06");
    assert.equal(P.isExpired("2026-09-05", evening), true);
  });

  await t.test("only a real ISO calendar date is accepted", () => {
    for (const bad of ["", "2026-13-01", "2026-02-31", "06/09/2026", "2026-9-6", null, 20260906]) {
      assert.equal(P.isoDateOnly(bad), null, String(bad));
    }
    assert.equal(P.isoDateOnly("2026-09-06"), "2026-09-06");
  });
});

test("stock figures must be Firestore integers", async (t) => {
  await t.test("a legacy STRING quantity is refused, never coerced", () => {
    // The three staging batches hold "120"/"35"/"80". Coercing them would make
    // the migration invisible and let the wrong stored type survive forever.
    assert.deepEqual(P.readStockInteger("120"), { ok: false, reason: "legacy-string" });
    assert.equal(codeOf(() => evaluate({ quantity: "120" })), "inventory-migration-required");
  });

  await t.test("non-integer and negative stock is refused", () => {
    for (const q of [1.5, -1, NaN, Infinity, null, undefined, {}, []]) {
      assert.equal(P.readStockInteger(q).ok, false, String(q));
    }
    assert.equal(P.readStockInteger(0).ok, true);
  });

  await t.test("absent reservedQuantity means zero; invalid does not", () => {
    assert.deepEqual(P.readReservedQuantity(undefined), { ok: true, value: 0 });
    assert.deepEqual(P.readReservedQuantity(null), { ok: true, value: 0 });
    assert.equal(P.readReservedQuantity("0").ok, false);
    assert.equal(P.readReservedQuantity(-1).ok, false);
    assert.equal(codeOf(() => evaluate({ reservedQuantity: "5" })), "inventory-invalid-reserved");
  });
});

test("requested quantities", async (t) => {
  await t.test("rejects zero, negative, decimal, string, NaN and undefined", () => {
    for (const q of [0, -1, -0.5, 2.5, "5", NaN, Infinity, undefined, null, true, {}]) {
      assert.equal(P.validateLineQuantity(q).ok, false, JSON.stringify(q));
    }
  });

  await t.test("rejects an oversized quantity distinctly", () => {
    assert.equal(P.validateLineQuantity(P.MAX_LINE_QUANTITY).ok, true);
    assert.equal(P.validateLineQuantity(P.MAX_LINE_QUANTITY + 1).code, "quantity-too-large");
  });
});

test("create payload shape", async (t) => {
  const ok = { items: [{ inventoryId: "inv1", quantity: 2 }] };

  await t.test("accepts a well-formed payload", () => {
    assert.deepEqual(P.validateCreatePayload(ok).items, [{ inventoryId: "inv1", quantity: 2 }]);
  });

  await t.test("rejects duplicate batches rather than combining them", () => {
    // Combining would silently change what the rep asked for; splitting across
    // batches is explicitly out of scope.
    const dup = { items: [{ inventoryId: "inv1", quantity: 2 }, { inventoryId: "inv1", quantity: 3 }] };
    assert.equal(codeOf(() => P.validateCreatePayload(dup)), "duplicate-inventory-line");
  });

  await t.test("rejects unknown fields instead of ignoring them", () => {
    const sneaky = { items: [{ inventoryId: "inv1", quantity: 2, name: "Free Vaccine" }] };
    assert.equal(codeOf(() => P.validateCreatePayload(sneaky)), "unknown-field");
  });

  await t.test("rejects empty, non-array and oversized item lists", () => {
    assert.equal(codeOf(() => P.validateCreatePayload({ items: [] })), "invalid-payload");
    assert.equal(codeOf(() => P.validateCreatePayload({ items: "x" })), "invalid-payload");
    assert.equal(codeOf(() => P.validateCreatePayload(null)), "invalid-payload");
    const many = { items: Array.from({ length: P.MAX_ORDER_LINES + 1 }, (_, i) => ({ inventoryId: `i${i}`, quantity: 1 })) };
    assert.equal(codeOf(() => P.validateCreatePayload(many)), "too-many-lines");
  });

  await t.test("rejects an inventoryId that is a path or blank", () => {
    for (const id of ["", "   ", "a/b", 5, null]) {
      assert.equal(codeOf(() => P.validateCreatePayload({ items: [{ inventoryId: id, quantity: 1 }] })), "invalid-payload");
    }
  });
});

test("batch evaluation", async (t) => {
  await t.test("allows a request within available stock", () => {
    const r = evaluate({}, 90); // 100 on hand - 10 reserved = 90 available
    assert.equal(r.quantity, 90);
    assert.equal(r.nextReservedQuantity, 100);
    assert.equal(r.available, 90);
  });

  await t.test("refuses one unit beyond available and reports the real figure", () => {
    try {
      evaluate({}, 91);
      assert.fail("should refuse");
    } catch (e) {
      assert.equal(e.code, "insufficient-stock");
      assert.equal(e.details.available, 90);
      assert.equal(e.details.requested, 91);
      assert.equal(e.details.batchId, "MOD-STG-001");
    }
  });

  await t.test("refuses missing, expired and unavailable batches", () => {
    assert.equal(
      codeOf(() => P.evaluateBatch({ inventoryId: "x", data: null, requested: 1, now: NOW })),
      "inventory-not-found"
    );
    assert.equal(codeOf(() => evaluate({ expiryDate: "2020-01-01" })), "batch-expired");
    assert.equal(codeOf(() => evaluate({ expiryDate: "not-a-date" })), "batch-expired");
    for (const status of ["Expired", "Recalled", "quarantine", "", null, 5]) {
      assert.equal(codeOf(() => evaluate({ status })), "batch-unavailable", String(status));
    }
  });

  await t.test("refuses a batch whose reserved figure exceeds its stock", () => {
    assert.equal(
      codeOf(() => evaluate({ quantity: 5, reservedQuantity: 10 })),
      "inventory-invariant-broken"
    );
  });

  await t.test("snapshots identity from the document, not from caller text", () => {
    // A stored `id` field must never become the allocation identity: the
    // document id is passed separately and used verbatim.
    const r = P.evaluateBatch({
      inventoryId: "REAL_DOC_ID",
      data: batch({ id: "ATTACKER_ID", vaccineName: "Moderna COVID-19 Vaccine" }),
      requested: 1,
      now: NOW,
    });
    assert.equal(r.inventoryId, "REAL_DOC_ID");
    assert.equal(r.name, "Moderna COVID-19 Vaccine");
    assert.equal(r.batchId, "MOD-STG-001");
  });
});

test("settlement arithmetic", async (t) => {
  await t.test("release lowers only reservedQuantity", () => {
    const u = P.settleBatch({ inventoryId: "i", data: batch({ reservedQuantity: 10 }), quantity: 4, mode: "release" });
    assert.deepEqual(u, { reservedQuantity: 6 });
  });

  await t.test("consume lowers both, by the same amount", () => {
    const u = P.settleBatch({ inventoryId: "i", data: batch({ quantity: 100, reservedQuantity: 10 }), quantity: 4, mode: "consume" });
    assert.deepEqual(u, { reservedQuantity: 6, quantity: 96 });
  });

  await t.test("never drives a counter negative — it fails instead", () => {
    assert.equal(
      codeOf(() => P.settleBatch({ inventoryId: "i", data: batch({ reservedQuantity: 2 }), quantity: 5, mode: "release" })),
      "inventory-invariant-broken"
    );
    assert.equal(
      codeOf(() => P.settleBatch({ inventoryId: "i", data: batch({ quantity: 3, reservedQuantity: 5 }), quantity: 5, mode: "consume" })),
      "inventory-invariant-broken"
    );
  });
});

test("idempotency fingerprint", async (t) => {
  const base = { uid: "sr1", clinicDocId: "c1", items: [{ inventoryId: "a", quantity: 1 }, { inventoryId: "b", quantity: 2 }] };

  await t.test("is stable regardless of line order", () => {
    const reordered = { ...base, items: [...base.items].reverse() };
    assert.equal(P.canonicalRequestFingerprint(base), P.canonicalRequestFingerprint(reordered));
  });

  await t.test("changes when the order genuinely changes", () => {
    const f = P.canonicalRequestFingerprint(base);
    assert.notEqual(f, P.canonicalRequestFingerprint({ ...base, uid: "sr2" }));
    assert.notEqual(f, P.canonicalRequestFingerprint({ ...base, clinicDocId: "c2" }));
    assert.notEqual(f, P.canonicalRequestFingerprint({ ...base, items: [{ inventoryId: "a", quantity: 9 }, { inventoryId: "b", quantity: 2 }] }));
    assert.notEqual(f, P.canonicalRequestFingerprint({ ...base, items: [{ inventoryId: "z", quantity: 1 }, { inventoryId: "b", quantity: 2 }] }));
  });

  await t.test("request ids must be long random tokens", () => {
    assert.equal(codeOf(() => P.validateRequestId("short")), "invalid-request-id");
    assert.equal(codeOf(() => P.validateRequestId("has spaces in it here")), "invalid-request-id");
    assert.equal(codeOf(() => P.validateRequestId(1234567890123456)), "invalid-request-id");
    assert.equal(codeOf(() => P.validateRequestId("a".repeat(65))), "invalid-request-id");
    assert.equal(codeOf(() => P.validateRequestId("has/slash/in/it/here!!")), "invalid-request-id");
    assert.equal(P.validateRequestId("a".repeat(32)), "a".repeat(32));
  });
});

test("legacy detection uses the version stamp only", () => {
  // Never name, SKU, batch text or item shape — those are the guesses this
  // policy exists to forbid.
  assert.equal(P.isLegacyOrder({}), true);
  assert.equal(P.isLegacyOrder({ items: [{ sku: "MOD-STG-001" }] }), true);
  assert.equal(P.isLegacyOrder({ allocationVersion: 0 }), true);
  assert.equal(P.isLegacyOrder({ allocationVersion: "1" }), true);
  assert.equal(P.isLegacyOrder({ allocationVersion: 1 }), false);
});

test("reason validation matches the shared lifecycle bounds", () => {
  assert.equal(P.MAX_REASON_LENGTH, 500);
  assert.equal(codeOf(() => P.validateReason("  ")), "reason-required");
  assert.equal(codeOf(() => P.validateReason("x".repeat(501))), "reason-too-long");
  assert.equal(P.validateReason("  Clinic closed  "), "Clinic closed");
});
