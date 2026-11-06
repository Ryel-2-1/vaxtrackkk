import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

import { MAX_LINE_QUANTITY as webLineLimit } from "../src/services/backorder.js";
import { PRICING_VERSION as webPricingVersion } from "../src/services/invoiceModel.js";

const require = createRequire(import.meta.url);
const serverPolicy = require("../functions/src/policy.js");

test("checkout and the authoritative order writer agree on line and pricing versions", () => {
  assert.equal(webLineLimit, serverPolicy.MAX_LINE_QUANTITY);
  assert.equal(webPricingVersion, serverPolicy.PRICING_VERSION);
  assert.equal(serverPolicy.PRICE_CURRENCY, "PHP");
});

test("Med Rep orders are created through the reservation callable only", () => {
  const service = readFileSync(new URL("../src/services/orderService.js", import.meta.url), "utf8");
  const checkout = readFileSync(new URL("../src/pages/salesRep/SalesRepPlaceOrder.jsx", import.meta.url), "utf8");
  const operations = readFileSync(new URL("../functions/src/operations.js", import.meta.url), "utf8");
  assert.doesNotMatch(service, /createSalesRepOrder|\baddDoc\(/);
  assert.match(checkout, /createOrderWithReservation\(/);
  assert.match(operations, /tx\.set\(orderRef, orderData\)/);
  assert.match(operations, /createdByUid: uid/);
});
