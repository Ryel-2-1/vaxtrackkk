import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { isSafeUserMessage } from "../src/services/liveDataErrors.js";

/**
 * The server's new refusals must reach the user as written. The web shows a
 * callable's sentence only if it passes isSafeUserMessage; anything that looks
 * like an identifier (a batch ID such as "AB_2026-001") swaps the whole
 * sentence for "please try again" — which is what staging showed for the
 * reschedule refusal before the batch ID was taken out of the message.
 */
const require = createRequire(import.meta.url);
const { assertBatchesCover } = require("../functions/src/expiryGuard.js");
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const refusal = (action, batch = { batchId: "AB_2026-001", expiryDate: "2026-11-07" }) => {
  try {
    assertBatchesCover([{ id: "invDocId123", data: batch }], "2026-11-10", { action });
  } catch (error) {
    return error.message;
  }
  throw new Error("expected a refusal");
};

test("expiry refusals at dispatch, delivery and reschedule are shown as written", () => {
  const actions = [
    read("functions/src/operations.js").match(/action: "(Do not hand it over[^"]+)"/)?.[1],
    read("functions/src/scheduleOperations.js").match(/action: "(Choose an earlier date[^"]+)"/)?.[1],
    "VT-ORD-1792765828925-FSGW cannot be dispatched with it. Cancel the order and place it again, or ask an Admin to review the stock.",
  ];
  assert.equal(actions.filter(Boolean).length, 3, "every action sentence was found");
  for (const action of actions) {
    const message = refusal(action);
    assert.ok(isSafeUserMessage(message), message);
    assert.doesNotMatch(message, /AB_2026-001|invDocId123/);
  }
  assert.ok(isSafeUserMessage(refusal("Check it.", null)));
});

test("the batch-edit and Med Rep destination refusals are shown as written", () => {
  const messages = [
    "VT-ORD-1792765828925-FSGW holds this batch for delivery on 2026-11-10, after the new expiry date. Reschedule or cancel that order first.",
    ...["functions/src/batchMetadata.js", "functions/src/medRepDestinations.js"].flatMap((file) =>
      [...read(file).matchAll(/new PolicyError\(\s*"[\w-]+",\s*"([^"]+)"/g)].map((m) => m[1])
    ),
  ];
  assert.ok(messages.length >= 8);
  for (const message of messages) assert.ok(isSafeUserMessage(message), message);
});
