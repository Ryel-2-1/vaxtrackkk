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
  // The live callable hands its location decision to the shared completion
  // transaction (completeDelivery), which runs it after the evidence check
  // and before any write.
  const live = fnBody(OPS, "markOrderDeliveredWithInventoryConsumption");
  const locationRead = live.indexOf("await tx.get(db.collection(RIDER_LOCATIONS).doc(uid))");
  const decision = live.indexOf("evaluateDeliveryGeofence(");
  assert.ok(live.indexOf("verifyLocation: async (tx, order) =>") > 0, "decided inside the transaction");
  assert.ok(locationRead > 0 && decision > locationRead, "location read (in tx) → decision");
  // The location is the authenticated caller's own tracking document.
  assert.match(live, /RIDER_LOCATIONS\)\.doc\(uid\)/);
  assert.match(live, /riderUid: uid,\s+actorUid: uid,/);

  const body = fnBody(OPS, "completeDelivery");
  const evidence = body.indexOf("deliveryEvidenceProblem(order, orderId, uid)");
  const verify = body.indexOf("await verifyLocation(tx, order)");
  const firstWrite = Math.min(...["tx.update(", "tx.set(", "tx.create("].map((k) => body.indexOf(k)).filter((i) => i >= 0));
  assert.ok(evidence > 0 && verify > evidence, "evidence → location decision");
  assert.ok(firstWrite > verify, "the decision precedes every write");
  // The already-delivered replay returns before the decision: retries stay idempotent.
  assert.ok(body.indexOf('order.status === "delivered"') < verify);
});

test("an offline record is the only device-sent position, and the server never trusts it alone", () => {
  const rules = strip(read("functions/src/offlineCompletion.js"));
  // Same geofence rule and accuracy limit as live completion, plus the server-owned trail.
  assert.match(rules, /distanceM <= destination\.radiusM/);
  assert.match(rules, /capture\.accuracyM > MAX_ACCURACY_M/);
  assert.match(rules, /if \(!before\) return review\("no_track"/);
  assert.match(rules, /MAX_OFFLINE_AGE_MS = 3 \* 60 \* 60 \* 1000/);
  // The trail only takes fixes stored promptly (never ones queued offline).
  assert.match(rules, /if \(written - captured > TRAIL_MAX_STORE_DELAY_MS\) return null;/);
  // Anything unverified waits for a person; a verified record uses the same
  // completion transaction as a live one.
  const ops = strip(read("functions/src/offlineCompletionOps.js"));
  const submit = ops.slice(ops.indexOf("async function submitOfflineDeliveryCompletion("), ops.indexOf("async function loadReviewer("));
  assert.match(submit, /if \(decision\.ok\) \{/);
  assert.match(submit, /return \{ stop: \{ orderId, status: "needs_review"/);
  assert.match(submit, /completeDelivery\(/);
  // The Rider app sends it from one place, with the order id and the fix only.
  const sender = read("../vaxtrack_mobile/lib/offline/offline_delivery_service.dart");
  assert.match(sender, /httpsCallable\('submitOfflineDeliveryCompletion'\)\s*\.call<Map<String, dynamic>>\(\{'orderId': orderId, 'capture': capture\.toPayload\(\)\}\)/);
});

test("the preflight only reads, and decides with the same function", () => {
  const body = fnBody(OPS, "validateDeliveryCompletionGeofence");
  assert.equal(/\.(set|update|create|delete)\(|runTransaction|batch\(/.test(body), false, "no writes");
  assert.match(body, /evaluateDeliveryGeofence\(/);
  assert.match(body, /order\.assignedRiderId !== uid/);
  assert.match(body, /DELIVERABLE_FROM\.includes\(order\.status\)/);
  // A Delayed order is refused with its own code, before the geofence.
  assert.ok(body.indexOf('order.status === "delayed"') < body.indexOf("evaluateDeliveryGeofence("));
  assert.match(INDEX, /exports\.validateDeliveryCompletionGeofence = callable\(/);
  // Only the order id is taken from the request — and the raw request is
  // passed ONLY to be checked to carry nothing else (assertOnlyOrderIdPayload).
  const exported = INDEX.slice(INDEX.indexOf("exports.validateDeliveryCompletionGeofence"));
  assert.match(exported.slice(0, 500), /orderId: data\.orderId, payload: data, now \}/);
  assert.match(body, /assertOnlyOrderIdPayload\(payload\)/);
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
