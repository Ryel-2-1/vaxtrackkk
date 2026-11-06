import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("the browser tab names the product", () => {
  assert.match(read("index.html"), /<title>VaxTrack<\/title>/);
});

test("Analytics starts in production builds only, never on staging", () => {
  const src = read("src/firebase.js");
  assert.match(src, /import\.meta\.env\.MODE === "production"/);
  assert.doesNotMatch(src, /if \(import\.meta\.env\.PROD\)/);
});
