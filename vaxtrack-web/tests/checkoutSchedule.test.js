import test from "node:test";
import assert from "node:assert/strict";
import { checkoutScheduleErrorMessage, validateCheckoutSchedule } from "../src/services/checkoutSchedule.js";

const at = (value) => new Date(value);
const timed = { requestedDeliveryDate: "2026-10-27", requestedArrival: { mode: "exact", time: "10:00" } };

test("new checkout accepts optional time and refuses dates/times already past in Manila", () => {
  const now = at("2026-10-27T03:00:00Z"); // 11:00 Manila
  assert.equal(validateCheckoutSchedule({ ...timed, now }).arrival.code, "requested-arrival-passed");
  assert.equal(validateCheckoutSchedule({ ...timed, requestedDeliveryDate: "2026-10-26", now }).date.ok, false);
  assert.deepEqual(validateCheckoutSchedule({ requestedDeliveryDate: "2026-10-27", now }).arrival.value, { version: 1, mode: "any_time" });
});

test("recovery retains the exact date/time after cutoff and across Manila midnight", () => {
  for (const now of [at("2026-10-27T03:00:00Z"), at("2026-10-27T16:01:00Z")]) {
    const r = validateCheckoutSchedule({ ...timed, now, recovering: true });
    assert.equal(r.date.value, "2026-10-27");
    assert.deepEqual(r.arrival.value, { version: 1, mode: "exact", time: "10:00" });
  }
});

test("recovery never relaxes structural validation or silently rewrites times", () => {
  const now = at("2026-10-28T03:00:00Z");
  for (const date of ["", "2026-02-31", "invalid"]) {
    assert.equal(validateCheckoutSchedule({ ...timed, requestedDeliveryDate: date, now, recovering: true }).date.ok, false);
  }
  for (const requestedArrival of [{ mode: "exact", time: "25:00" }, { mode: "window", start: "12:00", end: "10:00" }, { mode: "before", time: "00:00" }]) {
    assert.equal(validateCheckoutSchedule({ ...timed, requestedArrival, now, recovering: true }).arrival.ok, false);
  }
});

test("schema mismatch and invalid schedule messages do not blame connection or leak payload fields", () => {
  for (const code of ["unknown-field", "invalid-requested-arrival", "requested-arrival-passed"]) {
    const message = checkoutScheduleErrorMessage(code);
    assert.ok(message);
    assert.doesNotMatch(message, /connection|requestedArrival|INVALID_ARGUMENT|https?:/);
  }
  assert.match(checkoutScheduleErrorMessage("unknown-field"), /Contact an administrator before retrying/);
  assert.equal(checkoutScheduleErrorMessage("price-changed"), null);
});
