import test from "node:test";
import assert from "node:assert/strict";

import { messageForCallableError } from "../src/services/checkoutErrorMessages.js";

test("checkout errors keep actionable stock and price guidance", () => {
  assert.match(
    messageForCallableError({ code: "insufficient-stock", info: { available: 2, batchId: "BT-17" } }),
    /Only 2 left in batch BT-17\. Adjust the quantity/
  );
  const priceChanged = messageForCallableError({
    code: "price-changed",
    info: { batchId: "BT-17", expectedUnitPriceCentavos: 10000, currentUnitPriceCentavos: 12000 },
  });
  assert.match(priceChanged, /BT-17/);
  assert.match(priceChanged, /100\.00/);
  assert.match(priceChanged, /120\.00/);
  assert.match(priceChanged, /Nothing was placed/);
});

test("unknown checkout failures do not reveal untrusted server text", () => {
  const message = messageForCallableError({ code: "functions/internal", message: "secret diagnostic" });
  assert.match(message, /Your cart and entries are still here/);
  assert.doesNotMatch(message, /secret diagnostic/);
  assert.match(messageForCallableError({ code: "idempotency-conflict" }), /Check Order Tracking first/);
});
