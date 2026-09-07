"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../src/policy");

const NOW = new Date("2026-09-06T02:00:00.000Z"); // 10:00 in Manila

/** ₱1,250.00 per vial, VAT-exclusive — the price every fixture agrees on. */
const PRICE = 125000;

const batch = (over = {}) => ({
  quantity: 100,
  reservedQuantity: 10,
  sellingPriceCentavos: PRICE,
  status: "OK",
  expiryDate: "2027-12-31",
  batchId: "MOD-STG-001",
  vaccineName: "Moderna COVID-19 Vaccine",
  vaccineType: "COVID-19",
  manufacturer: "Moderna",
  ...over,
});

const evaluate = (over = {}, requested = 5, expected = PRICE) =>
  P.evaluateBatch({
    inventoryId: "inv1",
    data: batch(over),
    requested,
    expectedUnitPriceCentavos: expected,
    now: NOW,
  });

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
  const ok = { items: [{ inventoryId: "inv1", quantity: 2, expectedUnitPriceCentavos: PRICE }] };

  await t.test("accepts a well-formed payload", () => {
    assert.deepEqual(P.validateCreatePayload(ok).items, [{ inventoryId: "inv1", quantity: 2, expectedUnitPriceCentavos: PRICE }]);
  });

  await t.test("rejects duplicate batches rather than combining them", () => {
    // Combining would silently change what the rep asked for; splitting across
    // batches is explicitly out of scope.
    const dup = { items: [{ inventoryId: "inv1", quantity: 2, expectedUnitPriceCentavos: PRICE }, { inventoryId: "inv1", quantity: 3, expectedUnitPriceCentavos: PRICE }] };
    assert.equal(codeOf(() => P.validateCreatePayload(dup)), "duplicate-inventory-line");
  });

  await t.test("rejects unknown fields instead of ignoring them", () => {
    const sneaky = { items: [{ inventoryId: "inv1", quantity: 2, expectedUnitPriceCentavos: PRICE, name: "Free Vaccine" }] };
    assert.equal(codeOf(() => P.validateCreatePayload(sneaky)), "unknown-field");
  });

  await t.test("rejects empty, non-array and oversized item lists", () => {
    assert.equal(codeOf(() => P.validateCreatePayload({ items: [] })), "invalid-payload");
    assert.equal(codeOf(() => P.validateCreatePayload({ items: "x" })), "invalid-payload");
    assert.equal(codeOf(() => P.validateCreatePayload(null)), "invalid-payload");
    const many = { items: Array.from({ length: P.MAX_ORDER_LINES + 1 }, (_, i) => ({ inventoryId: `i${i}`, quantity: 1, expectedUnitPriceCentavos: PRICE })) };
    assert.equal(codeOf(() => P.validateCreatePayload(many)), "too-many-lines");
  });

  await t.test("rejects an inventoryId that is a path or blank", () => {
    for (const id of ["", "   ", "a/b", 5, null]) {
      assert.equal(codeOf(() => P.validateCreatePayload({ items: [{ inventoryId: id, quantity: 1, expectedUnitPriceCentavos: PRICE }] })), "invalid-payload");
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
      expectedUnitPriceCentavos: PRICE,
      now: NOW,
    });
    assert.equal(r.inventoryId, "REAL_DOC_ID");
    assert.equal(r.name, "Moderna COVID-19 Vaccine");
    assert.equal(r.batchId, "MOD-STG-001");
  });
});

/**
 * PRICING NEGATIVE CONTROLS.
 *
 * Every one of these describes a way a caller could have set its own price
 * before this checkpoint, plus the ways a batch's own price can be unusable.
 * The suite exists to fail loudly if the price ever becomes caller-supplied
 * again — a passing "reduced price is refused" test is the only thing standing
 * between the catalog and someone ordering vaccines at ₱0.01.
 */
test("a caller cannot set its own price", async (t) => {
  await t.test("REDUCED — expecting less than the batch costs is refused", () => {
    try {
      evaluate({}, 5, 1); // ₱0.01 against a ₱1,250.00 batch
      assert.fail("should refuse");
    } catch (e) {
      assert.equal(e.code, "price-changed");
      assert.equal(e.details.expectedUnitPriceCentavos, 1);
      assert.equal(e.details.currentUnitPriceCentavos, PRICE);
      assert.equal(e.details.batchId, "MOD-STG-001");
    }
  });

  await t.test("INFLATED — expecting more is refused just as firmly", () => {
    // Not a "safe" direction to wave through. The rep would be buying at a
    // price they were never shown, and only a human can decide about that.
    assert.equal(codeOf(() => evaluate({}, 5, PRICE + 1)), "price-changed");
    assert.equal(codeOf(() => evaluate({}, 5, PRICE * 10)), "price-changed");
  });

  await t.test("NEGATIVE and ZERO expectations never reach a comparison", () => {
    for (const bad of [-1, -125000, 0]) {
      assert.equal(P.validateExpectedPriceCentavos(bad).code, "invalid-expected-price", String(bad));
    }
  });

  await t.test("MALFORMED expectations are refused, never coerced", () => {
    // "125000" must not become 125000: a client sending a string is a client
    // that has drifted, and silently parsing it hides that.
    for (const bad of ["125000", 1250.5, NaN, Infinity, true, {}, [], "₱1,250"]) {
      assert.equal(
        P.validateExpectedPriceCentavos(bad).code,
        "invalid-expected-price",
        JSON.stringify(bad)
      );
    }
    // There is NO business ceiling: a genuinely expensive product is accepted.
    assert.equal(P.validateExpectedPriceCentavos(100000000000).ok, true, "₱1bn is fine");
    assert.equal(
      P.validateExpectedPriceCentavos(Number.MAX_SAFE_INTEGER).ok,
      true,
      "the largest exactly-representable integer is accepted"
    );
    // Only exactness is enforced. 2^53 and 2^53+1 are the same JS value, so a
    // figure past that point is not the figure anyone meant.
    assert.equal(
      P.validateExpectedPriceCentavos(Number.MAX_SAFE_INTEGER + 1).code,
      "invalid-expected-price"
    );
  });

  await t.test("MISSING — an unconfirmed price is not a confirmed one", () => {
    for (const missing of [undefined, null]) {
      assert.equal(P.validateExpectedPriceCentavos(missing).code, "price-not-confirmed");
    }
    // And the payload validator refuses the whole order, so a cart built before
    // pricing cannot slip through by simply omitting the field.
    assert.equal(
      codeOf(() => P.validateCreatePayload({ items: [{ inventoryId: "inv1", quantity: 1 }] })),
      "price-not-confirmed"
    );
  });

  await t.test("STALE — the price the cart was built at, after a re-price", () => {
    // The rep saw ₱1,250.00; an admin has since moved the batch to ₱1,400.00.
    const repriced = { sellingPriceCentavos: 140000 };
    assert.equal(codeOf(() => evaluate(repriced, 5, PRICE)), "price-changed");
    // ...and the same cart succeeds once it is rebuilt at the new price.
    assert.equal(evaluate(repriced, 5, 140000).unitPriceCentavos, 140000);
  });

  await t.test("`unitPrice` is now an UNKNOWN FIELD, not an ignored one", () => {
    // The old attack surface, closed loudly. A stale client that still believes
    // it sets prices must fail, not appear to succeed at a price it did choose.
    assert.equal(
      codeOf(() =>
        P.validateCreatePayload({
          items: [
            { inventoryId: "inv1", quantity: 1, expectedUnitPriceCentavos: PRICE, unitPrice: 0.01 },
          ],
        })
      ),
      "unknown-field"
    );
  });
});

test("a batch's own price must be usable", async (t) => {
  await t.test("UNPRICED batches cannot be ordered at all", () => {
    for (const missing of [undefined, null]) {
      const e = (() => {
        try {
          evaluate({ sellingPriceCentavos: missing });
          return null;
        } catch (err) {
          return err;
        }
      })();
      assert.equal(e.code, "batch-unpriced");
      assert.equal(e.details.reason, "missing");
    }
  });

  await t.test("a ZERO or NEGATIVE stored price is refused, not treated as free", () => {
    assert.equal(codeOf(() => evaluate({ sellingPriceCentavos: 0 })), "batch-unpriced");
    assert.equal(codeOf(() => evaluate({ sellingPriceCentavos: -1 })), "batch-unpriced");
    assert.deepEqual(P.readSellingPriceCentavos(0), { ok: false, reason: "not-positive" });
  });

  await t.test("a legacy STRING price is refused, exactly like a string quantity", () => {
    assert.deepEqual(P.readSellingPriceCentavos("125000"), { ok: false, reason: "legacy-string" });
    assert.equal(codeOf(() => evaluate({ sellingPriceCentavos: "125000" })), "batch-unpriced");
  });

  await t.test("a non-integer stored price is refused", () => {
    for (const bad of [1250.5, NaN, Infinity, true, {}, []]) {
      assert.equal(P.readSellingPriceCentavos(bad).ok, false, JSON.stringify(bad));
    }
  });

  await t.test("there is NO business ceiling — only an exactness limit", () => {
    // A genuinely expensive product must be sellable. The removed ₱100,000 cap
    // was an invented business rule; nothing approved it.
    assert.deepEqual(P.readSellingPriceCentavos(100000000000), {
      ok: true,
      value: 100000000000,
    });
    assert.deepEqual(P.readSellingPriceCentavos(Number.MAX_SAFE_INTEGER), {
      ok: true,
      value: Number.MAX_SAFE_INTEGER,
    });
    // Past MAX_SAFE_INTEGER the value is no longer distinguishable from its
    // neighbour, so it cannot be recorded honestly.
    assert.deepEqual(P.readSellingPriceCentavos(Number.MAX_SAFE_INTEGER + 1), {
      ok: false,
      reason: "not-safe-integer",
    });
    assert.equal(
      Number.MAX_SAFE_INTEGER + 1,
      Number.MAX_SAFE_INTEGER + 2,
      "the collision this refuses to record"
    );
  });

  await t.test("a line total that leaves the exact range fails, never rounds", () => {
    // With no ceiling this multiplication is the first overflow point, so it
    // carries its own guard rather than relying on bounds that no longer exist.
    assert.equal(
      codeOf(() => evaluate({ sellingPriceCentavos: Number.MAX_SAFE_INTEGER }, 2, Number.MAX_SAFE_INTEGER)),
      "line-total-out-of-range"
    );
    // ...while a large but exact line total still goes through.
    const r = evaluate({ sellingPriceCentavos: 100000000000 }, 90, 100000000000);
    assert.equal(r.lineTotalCentavos, 9000000000000);
  });

  await t.test("price is checked BEFORE stock, so the reason is the real one", () => {
    // An unpriced batch that is also out of stock reports the unpriced problem:
    // it is the one an admin can act on, and "out of stock" would send the rep
    // to wait for a delivery that would not help.
    assert.equal(
      codeOf(() => evaluate({ sellingPriceCentavos: null, quantity: 10, reservedQuantity: 10 })),
      "batch-unpriced"
    );
  });
});

test("server-side money arithmetic", async (t) => {
  await t.test("the line total is computed, never accepted", () => {
    const r = evaluate({}, 7);
    assert.equal(r.unitPriceCentavos, PRICE);
    assert.equal(r.lineTotalCentavos, 7 * PRICE);
  });

  await t.test("subtotals stay exact where peso floats would drift", () => {
    // Three lines at ₱0.10. In peso floats 0.1*3 is 0.30000000000000004, which
    // is exactly the drift the 0.01 invoice tolerance was absorbing.
    const lines = [
      { lineTotalCentavos: 10 },
      { lineTotalCentavos: 10 },
      { lineTotalCentavos: 10 },
    ];
    assert.equal(P.sumLineTotalsCentavos(lines), 30);
    assert.equal(P.centavosToPesos(30), 0.3);
    assert.notEqual(0.1 + 0.1 + 0.1, 0.3); // the reason centavos exist
  });

  await t.test("a total beyond exact integer range fails rather than rounds", () => {
    assert.equal(
      codeOf(() => P.sumLineTotalsCentavos([{ lineTotalCentavos: Number.MAX_SAFE_INTEGER }, { lineTotalCentavos: 2 }])),
      "order-total-out-of-range"
    );
  });

  await t.test("no price ceiling is exported — that was an invented business rule", () => {
    assert.equal(
      P.MAX_UNIT_PRICE_CENTAVOS,
      undefined,
      "a maximum price nobody approved must not exist"
    );
  });

  await t.test("centavos convert to pesos without inventing a fraction", () => {
    assert.equal(P.centavosToPesos(125000), 1250);
    assert.equal(P.centavosToPesos(1999), 19.99);
    assert.equal(P.centavosToPesos(1), 0.01);
  });
});

test("pricing version marks a server-priced order", () => {
  // Same discipline as allocation: the STAMP decides, never the item shape.
  // A legacy order keeps manual invoice pricing and is never back-filled.
  assert.equal(P.hasServerPricing({ pricingVersion: 1 }), true);
  assert.equal(P.hasServerPricing({}), false);
  assert.equal(P.hasServerPricing({ pricingVersion: "1" }), false);
  assert.equal(P.hasServerPricing({ pricingVersion: 0 }), false);
  assert.equal(P.hasServerPricing({ items: [{ unitPriceCentavos: 125000 }] }), false);
});

test("the idempotency fingerprint covers the agreed price", () => {
  // Two submissions of the same batches at different prices are two different
  // orders, and must not be able to share one request id.
  const base = {
    uid: "sr1",
    clinicDocId: "c1",
    items: [{ inventoryId: "a", quantity: 1, expectedUnitPriceCentavos: 125000 }],
  };
  const repriced = {
    ...base,
    items: [{ inventoryId: "a", quantity: 1, expectedUnitPriceCentavos: 140000 }],
  };
  assert.notEqual(
    P.canonicalRequestFingerprint(base),
    P.canonicalRequestFingerprint(repriced)
  );
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
