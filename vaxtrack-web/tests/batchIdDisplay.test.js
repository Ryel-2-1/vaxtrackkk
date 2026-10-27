import test from "node:test";
import assert from "node:assert/strict";
import { abbreviateBatchId, BATCH_ID_DISPLAY_MAX } from "../src/services/batchIdDisplay.js";

/**
 * Batch IDs have no length limit, so tables abbreviate long ones for display
 * (start…end); the stored value is untouched and shown in full elsewhere.
 */

const make = (length, fill) => fill.repeat(Math.ceil(length / fill.length)).slice(0, length);

test("IDs up to the display maximum are shown as they are", () => {
  assert.equal(BATCH_ID_DISPLAY_MAX, 24);
  for (const id of ["A", "PERF-0012", "PERF-1164-LONGBATCH-2026", make(24, "X")]) {
    assert.equal(abbreviateBatchId(id), null, id);
  }
});

test("31-, 64- and 128-character IDs keep their start and end, at the display maximum", () => {
  for (const length of [25, 31, 64, 128]) {
    for (const id of [make(length, "LOT-2026-ABCDEF-"), make(length, "ABCDEFGHJKMNPQRSTUVWXYZ0123456789")]) {
      const shown = abbreviateBatchId(id);
      assert.equal(Array.from(shown).length, BATCH_ID_DISPLAY_MAX, `${length}: ${shown}`);
      const [head, tail] = shown.split("…");
      assert.ok(id.startsWith(head), "keeps the start");
      assert.ok(id.endsWith(tail) && tail.length === 8, "keeps the last 8 characters");
    }
  }
});

test("characters outside the BMP are never split", () => {
  const id = "LOT-" + "𝟘".repeat(30);
  const shown = abbreviateBatchId(id);
  assert.equal(Array.from(shown).length, BATCH_ID_DISPLAY_MAX);
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(shown), false);
});

test("the stored value is not changed", () => {
  const id = make(64, "LOT-");
  const copy = String(id);
  abbreviateBatchId(id);
  assert.equal(id, copy);
});
