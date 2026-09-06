"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const M = require("../src/migrationPreview");

test("parseCanonicalInteger refuses everything ambiguous", async (t) => {
  await t.test("accepts only canonical non-negative integers", () => {
    assert.deepEqual(M.parseCanonicalInteger("120"), { ok: true, value: 120 });
    assert.deepEqual(M.parseCanonicalInteger("0"), { ok: true, value: 0 });
  });

  await t.test("refuses the shapes a naive parser would silently accept", () => {
    // parseInt("12abc") is 12 and Number(" ") is 0 — either would invent a
    // stock figure, which is the one thing a stock migration must never do.
    const cases = {
      "12abc": "non-numeric",
      "": "empty",
      " ": "whitespace",
      " 120": "whitespace",
      "120 ": "whitespace",
      "1.0": "decimal",
      "1.9": "decimal",
      "-5": "signed",
      "+5": "signed",
      "0120": "leading-zero",
      "1e3": "exponent",
      "1,200": "non-numeric",
      "١٢٠": "non-numeric",
    };
    for (const [input, reason] of Object.entries(cases)) {
      const r = M.parseCanonicalInteger(input);
      assert.equal(r.ok, false, input);
      assert.equal(r.reason, reason, input);
    }
  });

  await t.test("refuses values beyond safe integer range", () => {
    assert.equal(M.parseCanonicalInteger("9".repeat(20)).reason, "overflow");
  });

  await t.test("refuses non-strings", () => {
    for (const v of [120, null, undefined, {}, []]) {
      assert.equal(M.parseCanonicalInteger(v).ok, false, String(v));
    }
  });
});

test("planDocument", async (t) => {
  const doc = (quantity, over = {}) => ({
    id: "inv1",
    data: { quantity, batchId: "MOD-STG-001", ...over },
    hasReservations: false,
  });

  await t.test("converts a canonical string and initializes reservedQuantity", () => {
    const p = M.planDocument(doc("120"));
    assert.equal(p.action, "convert");
    assert.deepEqual(p.from, { quantity: "120", type: "string" });
    assert.equal(p.to.quantity, 120);
    assert.equal(p.to.reservedQuantity, 0);
    assert.equal(p.reservedQuantityInitialized, true);
  });

  await t.test("skips a document already stored as an integer", () => {
    assert.equal(M.planDocument(doc(120)).action, "skip");
  });

  await t.test("escalates a non-integer number rather than rounding it", () => {
    const p = M.planDocument(doc(1.5));
    assert.equal(p.action, "review");
    assert.equal(p.reason, "non-integer-number");
  });

  await t.test("escalates every ambiguous string with a named reason", () => {
    for (const [q, reason] of [["", "empty"], [" 12", "whitespace"], ["1.5", "decimal"], ["-3", "signed"], ["abc", "non-numeric"]]) {
      const p = M.planDocument(doc(q));
      assert.equal(p.action, "review", q);
      assert.equal(p.reason, reason, q);
    }
  });

  await t.test("will NOT zero reservedQuantity when reservations exist", () => {
    // Zeroing would erase a live reservation, and the correct value is unknown.
    const p = M.planDocument({ ...doc("120"), hasReservations: true });
    assert.equal(p.action, "review");
    assert.equal(p.reason, "reservations-exist-without-counter");
  });

  await t.test("escalates an existing invalid reservedQuantity", () => {
    const p = M.planDocument(doc("120", { reservedQuantity: -2 }));
    assert.equal(p.action, "review");
    assert.equal(p.reason, "invalid-reserved-quantity");
  });

  await t.test("keeps a valid existing reservedQuantity untouched", () => {
    const p = M.planDocument(doc("120", { reservedQuantity: 7 }));
    assert.equal(p.action, "convert");
    assert.equal(p.to.reservedQuantity, undefined);
    assert.equal(p.reservedQuantityInitialized, undefined);
  });

  await t.test("never proposes a vaccineId", () => {
    // Staging inventory has none and `vaccines` is empty; inventing the link
    // is exactly the guessing this policy forbids.
    const serialized = JSON.stringify(M.planDocument(doc("120")));
    assert.equal(serialized.includes("vaccineId"), false);
  });
});

test("buildMigrationPlan mirrors the three real staging documents", () => {
  const plan = M.buildMigrationPlan([
    { id: "4CTWaXmeYXnhyph7jaPD", data: { quantity: "120", batchId: "MOD-STG-001" }, hasReservations: false },
    { id: "7C5nUVz0SUJSajTnyJR3", data: { quantity: "35", batchId: "FLU-STG-002" }, hasReservations: false },
    { id: "WVknHqT40u57Wvzdvs76", data: { quantity: "80", batchId: "HEP-STG-003" }, hasReservations: false },
  ]);
  assert.equal(plan.mode, "preview");
  assert.equal(plan.convert.length, 3);
  assert.equal(plan.review.length, 0);
  assert.deepEqual(plan.convert.map((p) => p.to.quantity), [120, 35, 80]);

  const text = M.formatMigrationPlan(plan);
  assert.match(text, /PREVIEW ONLY, NOTHING WAS WRITTEN/);
  assert.match(text, /CONVERT {2}4CTWaXmeYXnhyph7jaPD/);
});

test("the planner has no write path at all", () => {
  // A migration module that CAN write is one flag away from writing. This
  // asserts the property structurally rather than trusting the reviewer's eye.
  assert.deepEqual(
    Object.keys(M).sort(),
    ["buildMigrationPlan", "formatMigrationPlan", "planDocument", "parseCanonicalInteger"].sort()
  );
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "migrationPreview.js"), "utf8");
  const forbidden = ["require(", "firebase-admin", "firestore()", ".set(", ".update(", ".commit(", ".delete(", "runTransaction", "batch()"];
  for (const token of forbidden) {
    assert.equal(source.includes(token), false, `migrationPreview must not contain "${token}"`);
  }
});
