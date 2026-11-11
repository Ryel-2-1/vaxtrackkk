import test from "node:test";
import assert from "node:assert/strict";
import { cleanDismissedIds, dispatcherPanelKey, loadDismissedIds, MAX_DISMISSED_NOTIFICATIONS,
  notificationPanelKey, notificationSwipeAction, saveDismissedIds } from "../src/services/notificationPanelState.js";

function memoryStorage() {
  const values = new Map();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test("panel deletions survive refresh and are private to the user, role and Firebase environment", () => {
  const storage = memoryStorage();
  saveDismissedIds("staging", "salesrep", "rep1", ["order1:loading"], storage);
  assert.deepEqual(loadDismissedIds("staging", "salesrep", "rep1", storage), ["order1:loading"]);
  for (const [project, role, uid] of [["production", "salesrep", "rep1"], ["staging", "dispatcher", "rep1"], ["staging", "salesrep", "rep2"]]) {
    assert.deepEqual(loadDismissedIds(project, role, uid, storage), []);
  }
  saveDismissedIds("staging", "salesrep", null, ["x"], storage);
  assert.equal(storage.values.size, 1, "no anonymous account preference is written");
});

test("damaged or blocked browser storage does not prevent using the bell", () => {
  const storage = memoryStorage();
  const key = notificationPanelKey("staging", "salesrep", "rep1");
  for (const value of ["bad json", "{}", "null", '["valid",3,null,"","valid"]']) {
    storage.values.set(key, value);
    assert.deepEqual(loadDismissedIds("staging", "salesrep", "rep1", storage), value.includes("valid") ? ["valid"] : []);
  }
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.deepEqual(loadDismissedIds("staging", "salesrep", "rep1", blocked), []);
  assert.doesNotThrow(() => saveDismissedIds("staging", "salesrep", "rep1", ["x"], blocked));
});

test("panel preference storage stays bounded without changing notification records", () => {
  const original = Array.from({ length: MAX_DISMISSED_NOTIFICATIONS + 10 }, (_, i) => `notice-${i}`);
  const snapshot = [...original];
  assert.deepEqual(cleanDismissedIds(original), original.slice(10));
  assert.deepEqual(original, snapshot);
  assert.deepEqual(cleanDismissedIds(["one", "one", "two"]), ["one", "two"]);
});

test("a new shipment status or Dispatcher event remains visible after dismissing an older event", () => {
  const dismissed = ["order1:loading", dispatcherPanelKey({ id: "alert1", atMs: 100 })];
  assert.equal(dismissed.includes("order1:in_transit"), false);
  assert.equal(dismissed.includes(dispatcherPanelKey({ id: "alert1", atMs: 200 })), false);
});

test("swipe actions require horizontal intent and ignore scrolling or short taps", () => {
  assert.equal(notificationSwipeAction(-70, 5), "open");
  assert.equal(notificationSwipeAction(70, -5), "close");
  for (const [x, y] of [[-20, 0], [0, 80], [-50, 65], [60, -100], [47, 0]]) {
    assert.equal(notificationSwipeAction(x, y), null);
  }
});
