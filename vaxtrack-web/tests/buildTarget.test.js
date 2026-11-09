import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkBuildTarget } from "../scripts/checkBuildTarget.mjs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("a build must use the Firebase project of its own mode", () => {
  assert.equal(checkBuildTarget("production", { VITE_FIREBASE_PROJECT_ID: "vaxtrack-bef1b" }), null);
  assert.equal(checkBuildTarget("staging", { VITE_FIREBASE_PROJECT_ID: "vaxtrack-staging" }), null);
  assert.match(checkBuildTarget("production", { VITE_FIREBASE_PROJECT_ID: "vaxtrack-staging" }), /must use Firebase project vaxtrack-bef1b/);
  assert.match(checkBuildTarget("staging", { VITE_FIREBASE_PROJECT_ID: "vaxtrack-bef1b" }), /must use Firebase project vaxtrack-staging/);
  assert.match(checkBuildTarget("production", {}), /not set/);
  assert.match(checkBuildTarget("preview", {}), /Unknown build mode/);
});

test("both build scripts run the check first, and Netlify defaults to staging", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.scripts["build:staging"], /^node scripts\/checkBuildTarget\.mjs staging && vite build --mode staging$/);
  assert.match(pkg.scripts["build:production"], /^node scripts\/checkBuildTarget\.mjs production && vite build --mode production$/);
  assert.match(read("../netlify.toml"), /command = "npm run build:\$\{VAXTRACK_BUILD_MODE:-staging\}"/);
});
