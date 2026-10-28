import test from "node:test";
import assert from "node:assert/strict";
import { motorcycleQaConfig } from "../src/services/motorcycleQaConfig.js";

test("motorcycle QA uses only a demo project on a loopback development server", () => {
  assert.equal(motorcycleQaConfig({ mode: "staging", dev: true, hostname: "localhost" }), null);
  assert.equal(motorcycleQaConfig({ mode: "production", dev: false, hostname: "example.com" }), null);
  for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
    assert.equal(motorcycleQaConfig({ mode: "motorcycle-qa", dev: true, hostname }).projectId,
      "demo-vaxtrack-motorcycle");
  }
  for (const config of [
    { mode: "motorcycle-qa", dev: false, hostname: "localhost" },
    { mode: "motorcycle-qa", dev: true, hostname: "example.com" },
  ]) assert.throws(() => motorcycleQaConfig(config), /local development server/);
});
