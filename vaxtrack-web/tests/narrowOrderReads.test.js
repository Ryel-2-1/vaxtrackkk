import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServiceLoader, createStore, installStore } from "./serviceHarness.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const loader = createServiceLoader();
const svc = await loader.load("deliveryService.js");

// Live screens read only the orders they show (2026-11-14). Synthetic data.

const seed = () => createStore({
  orders: {
    o1: { status: "pending_dispatch", createdAt: { toMillis: () => 1 } },
    o2: { status: "in_transit", tripId: "trip-A", stopSequence: 2, createdAt: { toMillis: () => 2 } },
    o3: { status: "delivered", tripId: "trip-A", stopSequence: 1, createdAt: { toMillis: () => 3 } },
    o4: { status: "delivered", tripId: "trip-old", stopSequence: 1, createdAt: { toMillis: () => 4 } },
    o5: { status: "cancelled", createdAt: { toMillis: () => 5 } },
    o6: { status: "Loading", createdAt: { toMillis: () => 6 } },
  },
});

test("open orders only: waiting, assigned, loading, in transit, delayed or failed (any spelling)", async () => {
  installStore(seed());
  let ids = null;
  svc.subscribeOpenDeliveries((orders) => { ids = orders.map((o) => o.id); });
  assert.deepEqual(ids, ["o6", "o2", "o1"], "newest first; delivered and cancelled are not read");
});

test("active trips keep their completed stops, and nothing from finished trips", async () => {
  installStore(seed());
  let ids = null;
  svc.subscribeActiveTripDeliveries((orders) => { ids = orders.map((o) => o.id).sort(); });
  assert.deepEqual(ids, ["o1", "o2", "o3", "o6"], "o3 is a delivered stop of open trip-A; trip-old is not read");
});

test("order totals are counted on the server, not by reading every order", async () => {
  installStore(seed());
  assert.deepEqual(await svc.countOrderTotals(), { total: 6, delivered: 2, cancelled: 1 });
});

test("live screens no longer listen to every order ever placed", () => {
  assert.match(read("src/components/tracking/LiveTrackingPanel.jsx"), /subscribeOpenDeliveries\(/);
  assert.match(read("src/pages/dispatcher/DispatcherDashboard.jsx"), /subscribeOpenDeliveries\(/);
  assert.match(read("src/pages/dispatcher/DispatcherGeofence.jsx"), /subscribeActiveTripDeliveries\(/);
  for (const f of ["src/components/tracking/LiveTrackingPanel.jsx", "src/pages/dispatcher/DispatcherDashboard.jsx",
    "src/pages/dispatcher/DispatcherGeofence.jsx", "src/pages/admin/AdminDashboard.jsx"]) {
    assert.doesNotMatch(read(f), /subscribeDeliveries\(/, f);
  }
});
