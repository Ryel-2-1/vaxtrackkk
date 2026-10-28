import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { orderArrivalNote } from "../src/services/requestedArrival.js";

// The SAME fixtures are executed by requested_arrival_test.dart on Flutter.
// This verifies the web side, not Dart compilation or phone rendering.
const fixtures = JSON.parse(readFileSync(new URL("../../vaxtrack_mobile/test/fixtures/requested_arrival_cases.json", import.meta.url), "utf8"));
for (const fixture of fixtures) {
  test(`Rider/web wording fixture: ${fixture.name}`, () => {
    assert.equal(orderArrivalNote(fixture.order), fixture.expected);
  });
}

test("Rider arrival presentation is wired to its model and remains independent of tracking/ETA", () => {
  const read = (path) => readFileSync(new URL(`../../vaxtrack_mobile/${path}`, import.meta.url), "utf8");
  const model = read("lib/models/delivery.dart");
  assert.match(model, /RequestedArrival.fromFirestore\(data\['requestedArrival'\]\)/);
  for (const field of ["requestedDeliveryDate", "originalRequestedDeliveryDate"]) {
    assert.ok(model.includes(`_nonBlank(data['${field}'])`));
  }
  for (const path of ["lib/widgets/delivery_list_card.dart", "lib/widgets/dashboard_delivery_card.dart"]) {
    assert.ok(read(path).includes("RequestedArrivalText(delivery: d)"), path);
  }
  assert.ok(read("lib/screens/delivery_detail_screen.dart").includes("d.requestedArrivalLabel"));
  const helper = read("lib/utils/requested_arrival.dart");
  assert.doesNotMatch(helper, /DateTime.now\(|\.toLocal\(|cloud_firestore|firebase|geolocator|httpsCallable|setDoc|updateDoc/);
  const widget = read("lib/widgets/requested_arrival_text.dart");
  assert.match(widget, /softWrap: true/);
  assert.doesNotMatch(widget, /TextOverflow.ellipsis|maxLines:/);
});
