import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DISPATCHER_TRANSITIONS,
  ORDER_STATUSES,
  RIDER_TRANSITIONS,
  STATUS_LABELS,
  TERMINAL_STATUSES,
} from "../src/services/orderWorkflow.js";

// Cross-contract: the Dart policy must not drift from the JavaScript one.
//
// The Rider app cannot import orderWorkflow.js, so lib/utils/order_workflow.dart
// carries an equivalent. Two hand-maintained copies of a security-relevant
// matrix will diverge unless something fails when they do — this is that
// something. It parses the Dart source and compares every table.

const here = dirname(fileURLToPath(import.meta.url));
const dartPath = join(here, "..", "..", "vaxtrack_mobile", "lib", "utils", "order_workflow.dart");
const dart = readFileSync(dartPath, "utf8");

/** Parse `const List<String> name = [ 'a', 'b' ];` */
function parseDartList(name) {
  const re = new RegExp(`const\\s+List<String>\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`);
  const match = dart.match(re);
  assert.ok(match, `could not find Dart list ${name}`);
  return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

/** Parse `const Map<String, List<String>> name = { 'k': ['a'], … };` */
function parseDartMapOfLists(name) {
  const re = new RegExp(`const\\s+Map<String,\\s*List<String>>\\s+${name}\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`);
  const match = dart.match(re);
  assert.ok(match, `could not find Dart map ${name}`);
  const out = {};
  for (const entry of match[1].matchAll(/'([a-z_]+)'\s*:\s*\[([^\]]*)\]/g)) {
    out[entry[1]] = [...entry[2].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  }
  return out;
}

/** Parse `const Map<String, String> name = { 'k': 'v', … };` */
function parseDartMapOfStrings(name) {
  const re = new RegExp(`const\\s+Map<String,\\s*String>\\s+${name}\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`);
  const match = dart.match(re);
  assert.ok(match, `could not find Dart map ${name}`);
  const out = {};
  for (const entry of match[1].matchAll(/'([a-z_]+)'\s*:\s*'([^']*)'/g)) {
    out[entry[1]] = entry[2];
  }
  return out;
}

test("the Dart file is actually parseable — the harness itself is honest", () => {
  // If these ever come back empty the comparisons below would pass vacuously.
  assert.ok(parseDartList("kOrderStatuses").length > 0);
  assert.ok(Object.keys(parseDartMapOfLists("kRiderTransitions")).length > 0);
  assert.ok(Object.keys(parseDartMapOfStrings("kStatusLabels")).length > 0);
});

test("canonical statuses match between Dart and JavaScript", () => {
  assert.deepEqual(parseDartList("kOrderStatuses"), [...ORDER_STATUSES]);
});

test("terminal statuses match between Dart and JavaScript", () => {
  assert.deepEqual(parseDartList("kTerminalStatuses"), [...TERMINAL_STATUSES]);
});

test("the dispatcher matrix matches between Dart and JavaScript", () => {
  const dartTable = parseDartMapOfLists("kDispatcherTransitions");
  assert.deepEqual(Object.keys(dartTable).sort(), [...ORDER_STATUSES].sort());
  for (const status of ORDER_STATUSES) {
    assert.deepEqual(
      dartTable[status],
      [...DISPATCHER_TRANSITIONS[status]],
      `dispatcher: ${status}`
    );
  }
});

test("the rider matrix matches between Dart and JavaScript", () => {
  const dartTable = parseDartMapOfLists("kRiderTransitions");
  assert.deepEqual(Object.keys(dartTable).sort(), [...ORDER_STATUSES].sort());
  for (const status of ORDER_STATUSES) {
    assert.deepEqual(
      dartTable[status],
      [...RIDER_TRANSITIONS[status]],
      `rider: ${status}`
    );
  }
});

test("status labels match between Dart and JavaScript", () => {
  assert.deepEqual(parseDartMapOfStrings("kStatusLabels"), { ...STATUS_LABELS });
});

test("the Dart rider surface exposes no loading or dispatch transition", () => {
  const riderTable = parseDartMapOfLists("kRiderTransitions");
  assert.deepEqual(riderTable.assigned, [], "rider cannot act on an assigned order");
  assert.deepEqual(riderTable.loading, [], "rider cannot act on a loading order");
  assert.ok(!riderTable.in_transit.includes("cancelled"), "rider cannot cancel");
  assert.ok(!riderTable.delayed.includes("cancelled"), "rider cannot cancel");
});

test("the Flutter service exposes no loading, dispatch or arbitrary status write", () => {
  const servicePath = join(here, "..", "..", "vaxtrack_mobile", "lib", "services", "delivery_service.dart");
  const service = readFileSync(servicePath, "utf8");

  // Method declarations, not the explanatory comment that records their removal.
  assert.doesNotMatch(service, /Future<void>\s+startLoading\s*\(/);
  assert.doesNotMatch(service, /Future<void>\s+startTransit\s*\(/);
  assert.doesNotMatch(service, /Future<void>\s+updateStatus\s*\(/);

  // The three that remain, each taking the current status so it can validate.
  assert.match(service, /Future<void>\s+reportDelay\(String orderId, String currentStatus, String reason\)/);
  assert.match(service, /Future<void>\s+resumeTransit\(String orderId, String currentStatus\)/);
  assert.match(service, /Future<void>\s+markDelivered\(String orderId, String currentStatus\)/);

  // Each validates before writing.
  const calls = service.match(/assertTransition\(kActorRider,/g) ?? [];
  assert.equal(calls.length, 3, "every rider write validates its transition");

  // Server timestamps and audit identity are unchanged.
  assert.match(service, /'delayedAt': FieldValue\.serverTimestamp\(\)/);
  assert.match(service, /'deliveredAt': FieldValue\.serverTimestamp\(\)/);
  assert.match(service, /'startedAt': FieldValue\.serverTimestamp\(\)/);
  assert.match(service, /_auditFields\(\)/);
});

test("the Flutter detail screen offers no loading or transit control", () => {
  const screenPath = join(here, "..", "..", "vaxtrack_mobile", "lib", "screens", "delivery_detail_screen.dart");
  const screen = readFileSync(screenPath, "utf8");

  assert.ok(!screen.includes("'Start Loading'"), "Start Loading must be gone");
  assert.ok(!screen.includes("'Start Transit'"), "Start Transit must be gone");
  assert.ok(!screen.includes("canStartLoading"));
  assert.ok(!screen.includes("canStartTransit"));

  // The approved rider actions, and the two waiting states.
  assert.match(screen, /'Resume Transit'/);
  assert.match(screen, /'Complete Delivery'/);
  assert.match(screen, /'Report Delay'/);
  assert.match(screen, /isAwaitingLoading/);
  assert.match(screen, /isAwaitingDispatch/);
});
