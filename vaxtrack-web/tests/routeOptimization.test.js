import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseOptimizedJobOrder,
  cumulativeLegSeconds,
} from "../src/services/routeService.js";

/**
 * The pure parsing pieces of multi-stop optimization. The network calls
 * (ORS /optimization + /directions) are thin wrappers around these; here we pin
 * the response-shape handling — the optimized visiting order and the per-stop
 * cumulative ETA — without touching the network.
 */

// ----------------------------------------------------- optimized visiting order

test("parseOptimizedJobOrder returns job ids in visiting order, skipping start/end", () => {
  const optResponse = {
    routes: [
      {
        steps: [
          { type: "start", location: [121.0, 14.5] },
          { type: "job", id: 2, location: [121.02, 14.55] },
          { type: "job", id: 1, location: [121.01, 14.52] },
          { type: "job", id: 3, location: [121.03, 14.58] },
          { type: "end", location: [121.03, 14.58] },
        ],
      },
    ],
  };
  assert.deepEqual(parseOptimizedJobOrder(optResponse), [2, 1, 3]);
});

test("parseOptimizedJobOrder is empty for a missing/unusable response", () => {
  assert.deepEqual(parseOptimizedJobOrder(null), []);
  assert.deepEqual(parseOptimizedJobOrder({}), []);
  assert.deepEqual(parseOptimizedJobOrder({ routes: [] }), []);
  assert.deepEqual(parseOptimizedJobOrder({ routes: [{ steps: [{ type: "start" }] }] }), []);
});

test("parseOptimizedJobOrder ignores steps with a non-numeric id", () => {
  const res = {
    routes: [{ steps: [{ type: "job", id: 1 }, { type: "job", id: "x" }, { type: "job", id: 4 }] }],
  };
  assert.deepEqual(parseOptimizedJobOrder(res), [1, 4]);
});

// --------------------------------------------------------- per-stop cumulative ETA

test("cumulativeLegSeconds accumulates leg durations into arrival times", () => {
  const segments = [{ duration: 60 }, { duration: 120 }, { duration: 90.4 }];
  // arrival at stop 1 = 60, stop 2 = 180, stop 3 = 270 (rounded)
  assert.deepEqual(cumulativeLegSeconds(segments), [60, 180, 270]);
});

test("cumulativeLegSeconds tolerates missing/junk durations and non-arrays", () => {
  assert.deepEqual(cumulativeLegSeconds([{ duration: 30 }, {}, { duration: 10 }]), [30, 30, 40]);
  assert.deepEqual(cumulativeLegSeconds([]), []);
  assert.deepEqual(cumulativeLegSeconds(null), []);
  assert.deepEqual(cumulativeLegSeconds(undefined), []);
});

// ------------------------------------------------------------- travel profile

test("internal routing stays on a motor-vehicle profile (ORS has no two-wheeler)", () => {
  // Riders ride motorcycles. The Rider app's Google Maps hand-off asks for
  // two-wheeler mode, but the route/ETA saved here comes from OpenRouteService,
  // whose only profiles are driving-car, driving-hgv, cycling-*, foot-* and
  // wheelchair. There is no motorcycle profile to switch to, and a cycling
  // profile would be a pedal-bike route — so driving-car is the closest honest
  // match. If this provider ever moves to the Google Routes API, the request
  // should use travelMode TWO_WHEELER and show the motorcycle beta warning.
  const src = readFileSync(
    new URL("../src/services/routeService.js", import.meta.url),
    "utf8"
  );
  assert.match(src, /\/v2\/directions\/driving-car"/, "directions profile");
  assert.match(src, /profile: "driving-car"/, "optimization vehicle profile");
  assert.equal(/cycling/.test(src), false, "never a bicycle profile");
  assert.equal(/TWO_WHEELER|two-wheeler/.test(src), false, "no unsupported mode is sent");
});
