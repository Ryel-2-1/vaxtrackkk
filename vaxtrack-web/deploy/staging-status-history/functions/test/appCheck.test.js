"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// App Check enforcement is a per-project deploy switch (ENFORCE_APP_CHECK in
// functions/.env.<projectId>). These prove the switch really gates the callables
// at the SDK layer, and that it is OFF unless explicitly turned on.

const PROBE = path.join(__dirname, "support", "appCheckProbe.js");

function probe(callableName, env) {
  const out = spawnSync(process.execPath, [PROBE, callableName], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  const line = out.stdout.split("\n").reverse().find((l) => l.startsWith('{"status"'));
  assert.ok(line, `no response from probe: ${out.stderr}`);
  return JSON.parse(line);
}

test("enforcement is off by default: a tokenless request reaches the handler", () => {
  const r = probe("createOrderWithReservation", { ENFORCE_APP_CHECK: "" });
  assert.equal(r.status, 401);
  assert.equal(r.body.error.message, "Please sign in and try again.");
});

test("with ENFORCE_APP_CHECK=true the SDK refuses a request without an App Check token", () => {
  for (const name of ["createOrderWithReservation", "cancelOrderWithInventoryRelease", "markOrderDeliveredWithInventoryConsumption"]) {
    const r = probe(name, { ENFORCE_APP_CHECK: "true" });
    assert.equal(r.status, 401, name);
    assert.equal(r.body.error.message, "Unauthenticated", `${name} must be refused before our handler runs`);
  }
});

test("only the exact value \"true\" turns enforcement on", () => {
  const r = probe("createOrderWithReservation", { ENFORCE_APP_CHECK: "yes" });
  assert.equal(r.body.error.message, "Please sign in and try again.");
});
