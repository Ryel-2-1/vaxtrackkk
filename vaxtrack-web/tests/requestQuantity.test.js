import test from "node:test";
import assert from "node:assert/strict";
import { assessRequestQuantity } from "../src/services/requestQuantity.js";

test("typed quantities stay editable while incomplete or invalid values cannot be added", () => {
  for (const value of ["", "0", "-1", "1.5", "e", "1000001"]) {
    assert.equal(assessRequestQuantity(value, 50).kind, "invalid", value);
  }
  assert.deepEqual(assessRequestQuantity("50", 50), { kind: "immediate", quantity: 50, message: "" });
});

test("current stock and the quantity already in the cart bound an immediate order", () => {
  assert.equal(assessRequestQuantity("7", 10, 3).kind, "immediate");
  const future = assessRequestQuantity("8", 10, 3);
  assert.equal(future.kind, "future");
  assert.match(future.message, /Only 7 more vials are available now/);
  assert.equal(assessRequestQuantity("1", 0).kind, "future");
});

test("a future order cannot exceed the server's per-line limit after cart merging", () => {
  assert.equal(assessRequestQuantity("2", 0, 999998).kind, "future");
  assert.equal(assessRequestQuantity("3", 0, 999998).kind, "invalid");
});
