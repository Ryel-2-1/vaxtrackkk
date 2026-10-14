import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Clinic delivery geofence — the contract across server and Rider app.
 *
 *  - The completion callable decides the geofence INSIDE its transaction,
 *    after the evidence check and before any write.
 *  - The preflight callable only reads.
 *  - No mobile path can complete a delivery except through that callable, and
 *    the device never sends a location, distance, verdict or time to either.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const fnBody = (src, name) => {
  const start = src.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, name);
  const next = src.indexOf("\nasync function ", start + 1);
  const end = next < 0 ? src.indexOf("\nmodule.exports", start) : next;
  return src.slice(start, end);
};

const OPS = strip(read("functions/src/operations.js"));
const INDEX = strip(read("functions/index.js"));

test("completion decides the geofence inside its transaction, after evidence, before any write", () => {
  const body = fnBody(OPS, "markOrderDeliveredWithInventoryConsumption");
  const evidence = body.indexOf("deliveryEvidenceProblem(order, orderId, uid)");
  const locationRead = body.indexOf("await tx.get(db.collection(RIDER_LOCATIONS).doc(uid))");
  const decision = body.indexOf("evaluateDeliveryGeofence(");
  const firstWrite = Math.min(...["tx.update(", "tx.set(", "tx.create("].map((k) => body.indexOf(k)).filter((i) => i >= 0));
  assert.ok(evidence > 0 && locationRead > evidence && decision > locationRead, "evidence → location read (in tx) → decision");
  assert.ok(firstWrite > decision, "the decision precedes every write");
  // The already-delivered replay returns before the decision: retries stay idempotent.
  assert.ok(body.indexOf('order.status === "delivered"') < decision);
  // The location is the authenticated caller's own tracking document.
  assert.match(body, /RIDER_LOCATIONS\)\.doc\(uid\)/);
});

test("the preflight only reads, and decides with the same function", () => {
  const body = fnBody(OPS, "validateDeliveryCompletionGeofence");
  assert.equal(/\.(set|update|create|delete)\(|runTransaction|batch\(/.test(body), false, "no writes");
  assert.match(body, /evaluateDeliveryGeofence\(/);
  assert.match(body, /order\.assignedRiderId !== uid/);
  assert.match(body, /DELIVERABLE_FROM\.includes\(order\.status\)/);
  assert.match(INDEX, /exports\.validateDeliveryCompletionGeofence = callable\(/);
  // Only the order id is taken from the request.
  const exported = INDEX.slice(INDEX.indexOf("exports.validateDeliveryCompletionGeofence"));
  assert.match(exported.slice(0, 400), /orderId: data\.orderId, now \}/);
  assert.equal(/data\.(lat|lng|latitude|longitude|distance|accuracy|capturedAt|inside|eligible|uid)/.test(exported.slice(0, 400)), false);
});

test("the geofence rule reads no client input and no route-deviation state", () => {
  const src = strip(read("functions/src/deliveryGeofence.js"));
  assert.equal(/riderDeviationStates|request\.data|payload/.test(src), false);
  assert.match(src, /distanceM <= destination\.radiusM/);
  assert.equal(/radiusM\s*\+|accuracyM\s*\+|\+\s*accuracy/.test(src), false, "accuracy is never added to the radius");
});

function dartFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...dartFiles(p));
    else if (name.endsWith(".dart")) out.push(p);
  }
  return out;
}

test("no mobile path completes a delivery without the server's geofence check", () => {
  const lib = join(here, "..", "..", "vaxtrack_mobile", "lib");
  const files = dartFiles(lib).map((p) => ({ p, src: readFileSync(p, "utf8") }));
  // Exactly one place calls the completion callable; it sends only the order id.
  const callers = files.filter((f) => f.src.includes("'markOrderDeliveredWithInventoryConsumption'"));
  assert.deepEqual(callers.map((f) => f.p.replace(/\\/g, "/").split("/lib/")[1]), ["services/delivery_service.dart"]);
  const service = callers[0].src;
  assert.match(service, /httpsCallable\('markOrderDeliveredWithInventoryConsumption'\)\s*\.call<Map<String, dynamic>>\(\{'orderId': orderId\}\)/);
  assert.match(service, /httpsCallable\('validateDeliveryCompletionGeofence'\)\s*\.call<Map<String, dynamic>>\(\{'orderId': orderId\}\)/);
  // No Rider code writes a delivered status directly (the rules refuse it too).
  for (const f of files) {
    assert.equal(/'status':\s*'delivered'/.test(f.src), false, f.p);
  }
  // Submit Proof & Complete: preflight before any upload, before completion.
  const controller = strip(read("../vaxtrack_mobile/lib/screens/proof_submission_controller.dart"));
  const flow = controller.slice(controller.indexOf("Future<bool> submitAndComplete("), controller.indexOf("Future<bool> _recordEvidence("));
  const check = flow.indexOf("await geofence.checkDeliveryGeofence(orderId)");
  assert.ok(check > 0, "the preflight runs in submitAndComplete");
  assert.ok(check < flow.indexOf("_recordEvidence("), "before any upload");
  assert.ok(check < flow.indexOf("completer.markDelivered("), "before completion");
  assert.match(controller, /throw StateError\('submitAndComplete needs a DeliveryGeofenceChecker'\)/);
  assert.match(read("../vaxtrack_mobile/lib/screens/proof_screen.dart"), /geofence: _deliveryService,/);
});

test("firestore.rules still let only the Rider write their own location", () => {
  const rules = read("firestore.rules");
  assert.match(rules, /match \/riderLocations\/\{riderUid\}/);
});
