"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeRequestedArrival,
  requestedArrivalOf,
  arrivalBounds,
  manilaClock,
} = require("../src/requestedArrival");
const { canonicalRequestFingerprint, validateCreatePayload } = require("../src/policy");

/**
 * The requested ARRIVAL at the destination, as the order-creation callable
 * accepts it. Server authority: what is refused here is refused for every
 * client, whatever the browser sent.
 */

// 2026-10-27 09:00 in Manila (01:00 UTC).
const NOW = new Date(Date.UTC(2026, 9, 27, 1, 0));
const TODAY = "2026-10-27";
const LATER = "2026-10-28";
const ok = (value, date = LATER) => normalizeRequestedArrival(value, { requestedDeliveryDate: date, now: NOW });
const refused = (value, code, pattern, date = LATER) =>
  assert.throws(() => ok(value, date), (e) => e.code === code && (!pattern || pattern.test(e.message)), JSON.stringify(value));

test("absent, null and any_time all mean any time within the requested day", () => {
  for (const v of [undefined, null, { mode: "any_time" }, { version: 1, mode: "any_time" }]) {
    assert.deepEqual(ok(v), { version: 1, mode: "any_time" });
  }
  assert.deepEqual(arrivalBounds({ mode: "any_time" }), [0, 1439], "the whole day, not midnight or noon");
});

test("window, before and exact are stored canonically with only their own fields", () => {
  assert.deepEqual(ok({ mode: "window", start: "10:00", end: "12:00" }), { version: 1, mode: "window", start: "10:00", end: "12:00" });
  assert.deepEqual(ok({ mode: "before", time: "10:00" }), { version: 1, mode: "before", time: "10:00" });
  assert.deepEqual(ok({ mode: "exact", time: " 10:00 " }), { version: 1, mode: "exact", time: "10:00" });
});

test("unknown modes and malformed values are refused, never defaulted", () => {
  refused({ mode: "morning" }, "invalid-requested-arrival");
  refused({ mode: "" }, "invalid-requested-arrival");
  refused({}, "invalid-requested-arrival");
  refused("10:00", "invalid-requested-arrival");
  refused(["window"], "invalid-requested-arrival");
  refused({ version: 2, mode: "any_time" }, "invalid-requested-arrival", /unsupported format/);
});

test("a mode cannot carry another mode's values (no stale fields persist)", () => {
  refused({ mode: "any_time", time: "10:00" }, "invalid-requested-arrival", /cannot carry "time"/);
  refused({ mode: "before", time: "10:00", start: "09:00" }, "invalid-requested-arrival", /cannot carry "start"/);
  refused({ mode: "window", start: "09:00", end: "10:00", time: "09:30" }, "invalid-requested-arrival");
});

test("missing required values are refused for each timed mode", () => {
  refused({ mode: "window", start: "10:00" }, "invalid-requested-arrival", /both the start and the end/);
  refused({ mode: "window", end: "12:00" }, "invalid-requested-arrival", /both the start and the end/);
  refused({ mode: "window", start: "", end: "12:00" }, "invalid-requested-arrival");
  refused({ mode: "before" }, "invalid-requested-arrival", /arrive before/);
  refused({ mode: "exact", time: null }, "invalid-requested-arrival", /exact delivery time/);
});

test("times must be HH:MM, 00:00–23:59", () => {
  for (const t of ["24:00", "9:30", "09:60", "0930", "09:30:00", "noon", 930]) {
    refused({ mode: "exact", time: t }, "invalid-requested-arrival", /HH:MM/);
  }
});

test("reversed and equal windows are refused, never read as overnight or as exact", () => {
  refused({ mode: "window", start: "12:00", end: "10:00" }, "invalid-requested-arrival", /Overnight windows are not supported/);
  refused({ mode: "window", start: "22:00", end: "02:00" }, "invalid-requested-arrival", /Overnight/);
  refused({ mode: "window", start: "10:00", end: "10:00" }, "invalid-requested-arrival", /exact time/);
});

test("noon and midnight are distinct and kept as entered", () => {
  assert.deepEqual(ok({ mode: "exact", time: "12:00" }), { version: 1, mode: "exact", time: "12:00" });
  assert.deepEqual(ok({ mode: "exact", time: "00:00" }), { version: 1, mode: "exact", time: "00:00" });
  assert.deepEqual(ok({ mode: "window", start: "00:00", end: "12:00" }), { version: 1, mode: "window", start: "00:00", end: "12:00" });
  // An explicit midnight is not "no time".
  assert.notDeepEqual(ok({ mode: "exact", time: "00:00" }), ok(null));
  // "Before midnight" (the start of the day) leaves no minute at all.
  refused({ mode: "before", time: "00:00" }, "invalid-requested-arrival", /leaves no time/);
});

test("boundaries: window inclusive, before strict, exact one minute", () => {
  assert.deepEqual(arrivalBounds({ mode: "window", start: "10:00", end: "12:00" }), [600, 720]);
  assert.deepEqual(arrivalBounds({ mode: "before", time: "10:00" }), [0, 599], "arriving AT 10:00 is not before it");
  assert.deepEqual(arrivalBounds({ mode: "exact", time: "10:00" }), [600, 600]);
});

test("a time already past today is refused; the same time on a later day is not", () => {
  // Now is 09:00 Manila.
  refused({ mode: "exact", time: "08:59" }, "requested-arrival-passed", /already passed/, TODAY);
  refused({ mode: "window", start: "07:00", end: "08:59" }, "requested-arrival-passed", null, TODAY);
  refused({ mode: "before", time: "09:00" }, "requested-arrival-passed", null, TODAY); // latest minute 08:59
  assert.equal(ok({ mode: "before", time: "09:01" }, TODAY).time, "09:01"); // 09:00 still allowed
  assert.equal(ok({ mode: "exact", time: "09:00" }, TODAY).time, "09:00");
  assert.equal(ok({ mode: "window", start: "07:00", end: "09:30" }, TODAY).end, "09:30");
  assert.equal(ok({ mode: "exact", time: "08:00" }, LATER).time, "08:00");
  assert.equal(ok({ mode: "any_time" }, TODAY).mode, "any_time");
});

test("Manila clock and date rollover use a fixed UTC+8, whatever the host timezone", () => {
  assert.deepEqual(manilaClock(new Date(Date.UTC(2026, 9, 27, 15, 59))), { date: "2026-10-27", minute: 23 * 60 + 59 });
  assert.deepEqual(manilaClock(new Date(Date.UTC(2026, 9, 27, 16, 0))), { date: "2026-10-28", minute: 0 });
  // At 23:59 Manila on the 27th, "today" is still the 27th: 23:59 exact is allowed, 23:58 is past.
  const late = new Date(Date.UTC(2026, 9, 27, 15, 59));
  assert.equal(normalizeRequestedArrival({ mode: "exact", time: "23:59" }, { requestedDeliveryDate: TODAY, now: late }).time, "23:59");
  assert.throws(() => normalizeRequestedArrival({ mode: "exact", time: "23:58" }, { requestedDeliveryDate: TODAY, now: late }));
  // One minute later it is the 28th: an early time on the 28th is fine again.
  const midnight = new Date(Date.UTC(2026, 9, 27, 16, 0));
  assert.equal(normalizeRequestedArrival({ mode: "exact", time: "00:00" }, { requestedDeliveryDate: LATER, now: midnight }).time, "00:00");
});

test("legacy orders without the field, and unrecognisable stored values, read as any time", () => {
  assert.deepEqual(requestedArrivalOf({}), { version: 1, mode: "any_time" });
  assert.deepEqual(requestedArrivalOf({ scheduledDeliveryTime: "09:30" }), { version: 1, mode: "any_time" }, "an Admin schedule time is not a request");
  assert.deepEqual(requestedArrivalOf({ requestedArrival: { mode: "exact", time: "9" } }), { version: 1, mode: "any_time" });
  assert.deepEqual(requestedArrivalOf({ requestedArrival: { mode: "before", time: "10:00" } }), { version: 1, mode: "before", time: "10:00" });
});

test("the create payload accepts requestedArrival and still refuses any other unknown key", () => {
  const base = { doctorId: "d", doctorAddressId: "home", items: [{ inventoryId: "b1", quantity: 1, expectedUnitPriceCentavos: 100 }] };
  assert.doesNotThrow(() => validateCreatePayload({ ...base, requestedArrival: { mode: "exact", time: "10:00" } }));
  assert.throws(() => validateCreatePayload({ ...base, requestedTime: "10:00" }), (e) => e.code === "unknown-field");
});

test("fingerprint v2 binds the requested arrival; omitting it reproduces the version-1 hash exactly", () => {
  const items = [{ inventoryId: "b1", quantity: 2, expectedUnitPriceCentavos: 100 }];
  const base = { uid: "u", doctorId: "d", doctorAddressId: "home", items };
  const v1 = canonicalRequestFingerprint(base);
  // The version-1 canonical form, rebuilt independently: nothing about it moved.
  const crypto = require("node:crypto");
  const legacyCanonical = JSON.stringify({
    uid: "u", doctorId: "d", doctorAddressId: "home",
    items: [{ inventoryId: "b1", quantity: 2, expectedUnitPriceCentavos: 100, agreedUnitPriceCentavos: 100, negotiationReason: null, statutoryDiscountType: null, statutoryDiscountCentavos: 0 }],
  });
  assert.equal(v1, crypto.createHash("sha256").update(legacyCanonical).digest("hex"));

  const schedule = (requestedArrival) => ({ ...base, schedule: { requestedArrival } });
  const exact10 = canonicalRequestFingerprint(schedule({ version: 1, mode: "exact", time: "10:00" }));
  assert.notEqual(exact10, v1);
  assert.equal(exact10, canonicalRequestFingerprint(schedule({ version: 1, mode: "exact", time: "10:00" })), "same intent, same hash");
  assert.notEqual(exact10, canonicalRequestFingerprint(schedule({ version: 1, mode: "before", time: "10:00" })), "a changed mode is a different request");
  assert.notEqual(exact10, canonicalRequestFingerprint(schedule({ version: 1, mode: "exact", time: "10:01" })), "a changed time is a different request");
  assert.notEqual(exact10, canonicalRequestFingerprint(schedule({ version: 1, mode: "any_time" })), "any time differs from a timed request");
});

test("fingerprint v3 binds date and arrival without changing either older hash", () => {
  const base = { uid: "u", doctorId: "d", doctorAddressId: "home", items: [{ inventoryId: "b1", quantity: 2 }] };
  const requestedArrival = { version: 1, mode: "exact", time: "10:00" };
  const fp = (date) => canonicalRequestFingerprint({ ...base, schedule: { requestedDeliveryDate: date, requestedArrival } });
  assert.equal(fp(TODAY), fp(TODAY));
  assert.notEqual(fp(TODAY), fp(LATER));
  assert.notEqual(fp(TODAY), canonicalRequestFingerprint({ ...base, schedule: { requestedArrival } }));
  assert.notEqual(fp(TODAY), canonicalRequestFingerprint(base));
});

test("recovery parsing skips only the clock, not arrival validation", () => {
  const options = { requestedDeliveryDate: TODAY, now: NOW, validateFuture: false };
  assert.equal(normalizeRequestedArrival({ mode: "exact", time: "08:00" }, options).time, "08:00");
  assert.throws(() => normalizeRequestedArrival({ mode: "exact", time: "25:00" }, options), (e) => e.code === "invalid-requested-arrival");
});
