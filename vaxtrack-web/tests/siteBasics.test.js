import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("the browser tab names the product", () => {
  assert.match(read("index.html"), /<title>VaxTrack<\/title>/);
});

test("Google Analytics is never started, in any build (2026-11-09)", () => {
  const src = read("src/firebase.js");
  assert.doesNotMatch(src, /import\(["']firebase\/analytics["']\)|from ["']firebase\/analytics["']/);
  assert.doesNotMatch(src, /getAnalytics\(/);
});
