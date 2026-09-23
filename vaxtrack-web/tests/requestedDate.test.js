import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isoDateOnly,
  manilaToday,
  validateRequestedDate,
} from "../src/services/requestedDate.js";

/**
 * The optional requested delivery date a Med Rep may add at checkout. The
 * Cloud Function re-validates the identical rule server-side
 * (functions/src/policy.js → normalizeRequestedDeliveryDate) and is the real
 * authority; this suite pins the client pre-check and the page wiring.
 */

const TODAY = "2026-06-15";
const opts = { today: TODAY };

// ------------------------------------------------------------ optional / blank

test("an absent or blank date is valid and yields null (the field is optional)", () => {
  for (const v of [undefined, null, "", "   "]) {
    const out = validateRequestedDate(v, opts);
    assert.equal(out.ok, true);
    assert.equal(out.value, null);
  }
});

// -------------------------------------------------------------------- shape

test("a present date must be a real YYYY-MM-DD", () => {
  for (const v of ["not-a-date", "2026/06/15", "2026-13-01", "2026-02-31", "26-06-15"]) {
    assert.equal(validateRequestedDate(v, opts).ok, false, `${v} must be rejected`);
  }
});

test("isoDateOnly accepts real dates and rejects impossible ones", () => {
  assert.equal(isoDateOnly("2026-06-15"), "2026-06-15");
  assert.equal(isoDateOnly("2026-02-31"), null);
  assert.equal(isoDateOnly("2026-6-1"), null);
  assert.equal(isoDateOnly(20260615), null);
});

// -------------------------------------------------------------- not in the past

test("a past date is refused; today and future are accepted", () => {
  assert.equal(validateRequestedDate("2026-06-14", opts).ok, false);
  const today = validateRequestedDate("2026-06-15", opts);
  assert.equal(today.ok, true);
  assert.equal(today.value, "2026-06-15");
  assert.equal(validateRequestedDate("2026-12-01", opts).ok, true);
});

test("manilaToday returns a YYYY-MM-DD string", () => {
  assert.match(manilaToday(), /^\d{4}-\d{2}-\d{2}$/);
  // A fixed instant just after Manila midnight (UTC+8) reads as that PH day.
  assert.equal(manilaToday(new Date("2026-06-15T00:30:00+08:00")), "2026-06-15");
  // Late-evening UTC that is already the next day in Manila.
  assert.equal(manilaToday(new Date("2026-06-14T20:00:00Z")), "2026-06-15");
});

// ============================================================ page + server shape

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("Place Order validates the date and sends it in the callable payload", () => {
  const src = read("src/pages/salesRep/SalesRepPlaceOrder.jsx");
  assert.match(
    src,
    /import \{[^}]*validateRequestedDate[^}]*\} from "\.\.\/\.\.\/services\/requestedDate"/,
    "must import the validator"
  );
  assert.match(src, /validateRequestedDate\(requestedDate\)/, "must validate before submit");
  assert.match(src, /requestedDeliveryDate: requestedCheck\.value/, "must send it in the payload");
  // The input is a date picker bounded to today (Manila) or later.
  assert.match(src, /type="date"/);
  assert.match(src, /min=\{manilaToday\(\)\}/, "the picker floor must be today");

  // The validation must gate the submit — it appears before setSaving(true).
  const handler = /const handleFinalizeOrder = async \(\) => \{[\s\S]*?\n {2}\};/.exec(src);
  assert.ok(handler, "the submit handler must exist");
  const checkAt = handler[0].indexOf("validateRequestedDate(requestedDate)");
  const savingAt = handler[0].indexOf("setSaving(true)");
  assert.ok(checkAt !== -1 && savingAt > checkAt, "the date is validated before the submit proceeds");
});

test("the createOrderWithReservation wrapper forwards the requested date to the callable", () => {
  // Regression guard: the page sent requestedDeliveryDate to this wrapper, but
  // the wrapper destructured only the other fields and dropped it, so it never
  // reached the Cloud Function and every order was stored undated.
  const src = read("src/services/inventoryCallables.js");
  const fn = /export async function createOrderWithReservation\(\{[\s\S]*?\n\s+return result\.data;/.exec(src);
  assert.ok(fn, "the wrapper must exist");
  const body = fn[0];
  assert.match(body, /requestedDeliveryDate,/, "the wrapper must accept the field");
  const createAt = body.indexOf("callables().create({");
  const itemsAt = body.indexOf("items:", createAt);
  const fieldAt = body.indexOf("requestedDeliveryDate", createAt);
  assert.ok(
    createAt !== -1 && fieldAt !== -1 && fieldAt < itemsAt,
    "the wrapper must forward requestedDeliveryDate in the create() payload"
  );
});

test("the requested date is surfaced in tracking and confirmation", () => {
  const tracking = read("src/pages/salesRep/SalesRepOrderTracking.jsx");
  assert.match(tracking, /requestedDeliveryDate: raw\.requestedDeliveryDate/, "tracking normalizes it");
  assert.match(tracking, /Requested delivery date/i, "tracking shows it");

  const confirmation = read("src/pages/salesRep/SalesRepOrderConfirmation.jsx");
  assert.match(confirmation, /requestedDeliveryDate/, "confirmation reads it");
  assert.match(confirmation, /Requested Delivery Date/i, "confirmation shows it");
});

test("the Cloud Function validates and persists the date, only when present", () => {
  const policy = read("functions/src/policy.js");
  assert.match(policy, /function normalizeRequestedDeliveryDate\(value, now\)/, "server validator exists");
  assert.match(policy, /normalizeRequestedDeliveryDate,/, "and is exported");

  const ops = read("functions/src/operations.js");
  assert.match(ops, /normalizeRequestedDeliveryDate\(\s*payload\?\.requestedDeliveryDate/, "callable validates it");
  assert.match(
    ops,
    /\.\.\.\(requestedDeliveryDate \? \{ requestedDeliveryDate \} : \{\}\)/,
    "callable stores it only when present"
  );
});
