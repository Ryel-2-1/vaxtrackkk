"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getOrderMedRepNames, MAX_ORDERS } = require("../src/orderMedRepNames");

function fakeDb(records) {
  const reads = [];
  return {
    reads,
    collection(collection) {
      return {
        doc(id) {
          return {
            async get() {
              reads.push(`${collection}/${id}`);
              const data = records[`${collection}/${id}`];
              return { exists: data !== undefined, data: () => data };
            },
          };
        },
      };
    },
  };
}

async function codeOf(promise) {
  try { await promise; return null; } catch (error) { return error.code; }
}

test("Dispatcher sees only current names for owners of requested orders", async () => {
  const db = fakeDb({
    "users/dispatcher": { role: "dispatcher", status: "approved" },
    "users/rep1": { role: "salesrep", status: "approved", name: "Updated Med Rep Name" },
    "orders/one": { createdByUid: "rep1", salesRepName: "Old snapshot" },
    "orders/two": { createdByUid: "rep1" },
    "orders/no-owner": {},
  });
  const result = await getOrderMedRepNames({ db, uid: "dispatcher", payload: { orderIds: ["one", "two", "no-owner", "missing"] } });
  assert.equal(result.names.one, "Updated Med Rep Name");
  assert.equal(result.names.two, "Updated Med Rep Name");
  assert.equal(Object.hasOwn(result.names, "no-owner"), false);
  assert.equal(Object.hasOwn(result.names, "missing"), false);
  assert.equal(db.reads.filter((path) => path === "users/rep1").length, 1);
});

test("only approved Admin and Dispatcher accounts can resolve names", async () => {
  const db = fakeDb({
    "users/admin": { role: "admin", status: "approved" },
    "users/dispatcher": { role: "dispatcher", status: "approved" },
    "users/rep": { role: "salesrep", status: "approved" },
    "users/pending": { role: "dispatcher", status: "pending" },
  });
  for (const uid of ["admin", "dispatcher"]) {
    assert.deepEqual(Object.keys((await getOrderMedRepNames({ db, uid, payload: { orderIds: ["missing"] } })).names), []);
  }
  assert.equal(await codeOf(getOrderMedRepNames({ db, uid: "rep", payload: { orderIds: ["missing"] } })), "wrong-role");
  assert.equal(await codeOf(getOrderMedRepNames({ db, uid: "pending", payload: { orderIds: ["missing"] } })), "not-approved");
  assert.equal(await codeOf(getOrderMedRepNames({ db, uid: "unknown", payload: { orderIds: ["missing"] } })), "profile-missing");
  assert.equal(db.reads.some((path) => path.startsWith("orders/")), true);
});

test("lookup is bounded to valid order IDs and accepts no extra fields", async () => {
  const db = fakeDb({ "users/admin": { role: "admin", status: "approved" } });
  for (const payload of [null, {}, { orderIds: [] }, { orderIds: ["bad/id"] }, { orderIds: [" spaced "] },
    { orderIds: Array.from({ length: MAX_ORDERS + 1 }, (_, i) => `order-${i}`) }]) {
    assert.equal(await codeOf(getOrderMedRepNames({ db, uid: "admin", payload })), "invalid-payload");
  }
  assert.equal(await codeOf(getOrderMedRepNames({ db, uid: "admin", payload: { orderIds: ["one"], role: "admin" } })), "unknown-field");
  assert.equal(db.reads.some((path) => path.startsWith("orders/")), false);
});
